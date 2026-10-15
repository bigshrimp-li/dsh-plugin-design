# 兼容路径

`support.js` 现在是指向 `../dist/design-runtime/support.js` 的符号链接，不包含第三方实现。

该路径保留给尚未重启的旧版本地插件服务，防止升级过程中读取旧路径时报文件缺失。
当前服务端、截图和导出均使用 `src/design-runtime/resource.ts` 定义的统一入口。
发布包不包含本目录；运行 `npm run build` 生成本地运行时后，兼容链接即可读取同一产物。

不要在此路径维护源码，也不要恢复旧 bundle 或外部检出构建脚本。
