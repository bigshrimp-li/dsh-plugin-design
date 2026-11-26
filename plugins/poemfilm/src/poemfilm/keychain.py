"""Store API keys in macOS Keychain. Secret bytes never enter process arguments."""

import ctypes as C
import sys

from .core import Fail

SERVICE = b"poemfilm.project-api-key"
MISSING = -25300


class Keychain:
    def __init__(self):
        if sys.platform != "darwin":
            raise Fail("credential_locked", "此设备没有 macOS 钥匙串。", 6)
        self.security = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
        self.cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        ref, word, ptr = C.c_void_p, C.c_uint32, C.POINTER
        self.cf.CFRelease.argtypes = [ref]
        self.cf.CFRelease.restype = None
        funcs = {
            "SecKeychainFindGenericPassword": [
                ref,
                word,
                C.c_char_p,
                word,
                C.c_char_p,
                ptr(word),
                ptr(ref),
                ptr(ref),
            ],
            "SecKeychainAddGenericPassword": [
                ref,
                word,
                C.c_char_p,
                word,
                C.c_char_p,
                word,
                ref,
                ptr(ref),
            ],
            "SecKeychainItemFreeContent": [ref, ref],
            "SecKeychainItemDelete": [ref],
            "SecKeychainItemCopyKeychain": [ref, ptr(ref)],
            "SecKeychainGetStatus": [ref, ptr(word)],
        }
        for name, types in funcs.items():
            fn = getattr(self.security, name)
            fn.argtypes, fn.restype = types, C.c_int32

    @staticmethod
    def check(code):
        if code == MISSING:
            raise Fail("credential_missing", "钥匙串中找不到该配置的凭证。", 6)
        if code:
            raise Fail(
                "credential_locked",
                "无法访问钥匙串，请在本机解锁后重试。",
                6,
                keychain_status=int(code),
            )

    def add(self, account, secret):
        label, data = account.encode(), secret.encode()
        self.check(
            self.security.SecKeychainAddGenericPassword(
                None, len(SERVICE), SERVICE, len(label), label, len(data), data, None
            )
        )

    def _find(self, account, read=False):
        label = account.encode()
        length, content, item = C.c_uint32(), C.c_void_p(), C.c_void_p()
        self.check(
            self.security.SecKeychainFindGenericPassword(
                None,
                len(SERVICE),
                SERVICE,
                len(label),
                label,
                C.byref(length) if read else None,
                C.byref(content) if read else None,
                C.byref(item),
            )
        )
        try:
            data = C.string_at(content, length.value).decode() if read else None
        finally:
            if content:
                self.security.SecKeychainItemFreeContent(None, content)
        return item, data

    def get(self, account):
        item, data = self._find(account, read=True)
        self.cf.CFRelease(item)
        return data

    def probe(self, account):
        item, _ = self._find(account)
        container, status = C.c_void_p(), C.c_uint32()
        try:
            self.check(self.security.SecKeychainItemCopyKeychain(item, C.byref(container)))
            self.check(self.security.SecKeychainGetStatus(container, C.byref(status)))
            if not status.value & 1:  # kSecUnlockStateStatus
                raise Fail("credential_locked", "当前钥匙串处于锁定状态。", 6)
        finally:
            if container:
                self.cf.CFRelease(container)
            self.cf.CFRelease(item)

    def remove(self, account):
        try:
            item, _ = self._find(account)
        except Fail as exc:
            if exc.code == "credential_missing":
                return
            raise
        try:
            self.check(self.security.SecKeychainItemDelete(item))
        finally:
            self.cf.CFRelease(item)
