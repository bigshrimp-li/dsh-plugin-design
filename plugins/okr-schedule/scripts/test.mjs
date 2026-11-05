import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const browser=process.argv.includes('--browser');
const isBrowserSuite = file => file === 'browser.test.mjs' || file.endsWith('.browser.mjs');
const files = (await fs.readdir('test')).filter(file => browser ? isBrowserSuite(file) : file.endsWith('.test.mjs') && !isBrowserSuite(file)).sort().map(file => 'test/' + file);
const result=spawnSync(process.execPath,['--test',...files],{stdio:'inherit',env:{...process.env,...(browser?{OKR_BROWSER_TEST:'1'}:{})}});
if(result.error)throw result.error;process.exit(result.status??1);
