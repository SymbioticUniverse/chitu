/**
 * test-adapters.ts — 验证自适应模块
 * 与现有代码的兼容性测试
 */
import { fullScan } from "../src/adapters/index.js";

const scan = fullScan();
console.log(scan.report);
