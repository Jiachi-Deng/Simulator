import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as tar from 'tar'

export type OpenDesignM1CaseGroup = 'dashboard' | 'landing' | 'editor' | 'settings' | 'follow-up'

export interface OpenDesignM1Case {
  readonly id: string
  readonly group: OpenDesignM1CaseGroup
  readonly title: string
  readonly seedKind: 'blank-static-project' | 'preset-follow-up-project'
  readonly seedArchiveSha256: string
  readonly prompt: string
  readonly requiredFiles: readonly string[]
  readonly requiredContent: readonly { readonly path: string; readonly marker: string }[]
  readonly previewRoute: '/'
  readonly visualAssertion: string
}

function createCase(
  id: string,
  group: OpenDesignM1CaseGroup,
  title: string,
  marker: string,
  task: string,
  visualAssertion: string,
  seedKind: OpenDesignM1Case['seedKind'] = 'blank-static-project',
  seedArchiveSha256 = '',
): OpenDesignM1Case {
  const followUpBoundary = seedKind === 'preset-follow-up-project'
    ? '这是一次预置 transcript 后的单轮修改；只依据工作区现有文件与 TRANSCRIPT.md，不要求或假设可恢复旧 Agent Session。'
    : '从当前最小 seed 开始，不要安装依赖。'
  const evidencePath = `evidence/${id}.json`
  return Object.freeze({
    id,
    group,
    title,
    seedKind,
    seedArchiveSha256,
    prompt: `${followUpBoundary}\n${task}\n必须修改 index.html 和现有内容，并创建或修改 src/main.js、src/styles.css。index.html 必须包含精确标签 <script type="module" src="/src/main.js"></script>；src/styles.css 必须定义 --m1-accent；src/main.js 必须保留精确 marker 注释 ${marker}。另外创建 ${evidencePath}，写入 caseId=${id} 与 marker=${marker}。最终必须启动可交互 Preview，不要只回复说明或静态图片。`,
    requiredFiles: Object.freeze(['index.html', 'src/main.js', 'src/styles.css', evidencePath]),
    requiredContent: Object.freeze([
      { path: 'index.html', marker: '<script type="module" src="/src/main.js"></script>' },
      { path: 'src/main.js', marker },
      { path: 'src/styles.css', marker: '--m1-accent' },
      { path: evidencePath, marker: id },
    ]),
    previewRoute: '/',
    visualAssertion,
  })
}

export const OPEN_DESIGN_M1_CASES: readonly OpenDesignM1Case[] = Object.freeze([
  createCase('D01', 'dashboard', '订单管理仪表盘', 'M1-D01-ORDERS',
    '创建订单管理仪表盘，包含 KPI、订单列表、状态筛选和可开合的右侧订单详情抽屉。至少提供 8 条有区分度的订单数据。',
    '同屏可辨认 KPI、筛选、订单表；点击一行会打开右侧详情抽屉。',
    'blank-static-project', 'a04bbe467f345e60700355b0821e583f40c856bb5cbc84e8bf77f15b817246e1'),
  createCase('D02', 'dashboard', '订阅收入仪表盘', 'M1-D02-REVENUE',
    '创建订阅收入仪表盘，包含 MRR、流失率、收入趋势图、套餐构成和最近交易；图表需用原生 SVG 或 CSS 实现。',
    '收入趋势、套餐构成与最近交易层级清楚，切换时间范围会更新可见状态。',
    'blank-static-project', '52b1b0b886b78ee0de2b17ba0cb8b6862e0199945d39a0ecf1cd1b97afd5a334'),
  createCase('D03', 'dashboard', '客服运营仪表盘', 'M1-D03-SUPPORT',
    '创建客服运营仪表盘，包含待处理工单、SLA 风险、渠道分布、客服负载和可筛选工单队列。',
    'SLA 风险有明确警示，渠道与客服负载可区分，队列筛选真实改变行项目。',
    'blank-static-project', '0bf121649167315fd1350a65ca430ea384047a3578e3966993b89817e8b0fdeb'),
  createCase('D04', 'dashboard', '项目组合仪表盘', 'M1-D04-PORTFOLIO',
    '创建项目组合仪表盘，包含总体进度、风险矩阵、里程碑时间线、负责人和项目卡片。',
    '风险、进度、里程碑是三种不同信息表达，项目卡片可展开查看详情。',
    'blank-static-project', 'f8759b992a36645dd285d2e0152a1e32e01f5d019c8204644327b4b4efccc5a2'),

  createCase('L01', 'landing', 'B2B SaaS Landing', 'M1-L01-SAAS',
    '创建一页式 B2B SaaS Landing Page，包含 hero、客户 logo、价值主张、三档定价、FAQ 和最终 CTA。',
    '首屏 CTA 明确，定价三档可比较，FAQ 可展开，页面在窄宽度下不溢出。',
    'blank-static-project', '144cd72d6338a2375ba6f51d48382a276a71912924181897f96b46df03e24f97'),
  createCase('L02', 'landing', '运动鞋电商首页', 'M1-L02-SNEAKERS',
    '创建运动鞋电商首页，包含促销 hero、品类筛选、8 个商品卡、收藏按钮、快速加入购物袋和购物袋数量。',
    '商品层级和价格清楚，收藏与加入购物袋有即时可见反馈。',
    'blank-static-project', '7d91a8e44f2e2d7c910942979d26f57085c5bc1b3d59d36c8b48e8435271f75b'),
  createCase('L03', 'landing', '城市餐厅官网', 'M1-L03-RESTAURANT',
    '创建现代城市餐厅官网，包含菜单精选、营业信息、主厨故事、评价和可操作的预约人数/日期/时间表单。',
    '餐厅氛围一致，菜单可读，预约控件完整且提交后出现确认反馈。',
    'blank-static-project', '76216f0065842ba634c19aa61e459f327c93225f0bbfb601cc4793ded634a4d6'),
  createCase('L04', 'landing', '设计大会活动页', 'M1-L04-CONFERENCE',
    '创建两天设计大会活动页，包含讲者、双日议程、会场信息、票种和购票 CTA；议程可按日期切换。',
    '讲者、议程、票种层级清楚，日期切换真实改变议程内容。',
    'blank-static-project', '842874ae8432fcf05b62e416bdaf920d0c28a1bbe3a9859524123a659a180a94'),

  createCase('E01', 'editor', '协作白板', 'M1-E01-WHITEBOARD',
    '创建协作白板界面，包含左侧工具栏、可缩放画布、3 种便签、连接线、选择状态和右侧属性面板。',
    '画布与工具/属性面板界限清楚，点击便签会改变选中状态和属性内容。',
    'blank-static-project', 'bdf63052199ebe1dcb3d7d84c0c2250aa4997f8211eba47ed3faa6f75b759c3e'),
  createCase('E02', 'editor', '图片编辑器', 'M1-E02-IMAGE',
    '创建图片编辑器界面，包含图层列表、中央画布、裁剪/旋转工具、亮度和对比度滑杆、前后对比开关。',
    '三栏编辑器结构稳定，滑杆和前后对比开关产生可见画布变化。',
    'blank-static-project', '76bf77374d181d6b0c625e95265017a32431f479c955a2a14ed8081b5e1f2ccd'),
  createCase('E03', 'editor', '页面搭建器', 'M1-E03-BUILDER',
    '创建页面搭建器，包含组件库、页面画布、选中组件边框、响应式宽度切换和属性编辑器。',
    '组件库、画布、属性区清楚；切换设备宽度和编辑文本会更新画布。',
    'blank-static-project', 'f684487050d0afb8cab660885a634057f523fa2044d8f5d2cf0d1e25fa31bc6f'),
  createCase('E04', 'editor', '自动化流程编辑器', 'M1-E04-FLOW',
    '创建自动化流程编辑器，包含触发器、条件、动作节点、连接线、运行日志和启用开关。',
    '节点流向可理解，选中节点有详情，启用与模拟运行会更新状态/日志。',
    'blank-static-project', '9b957e380dc099be9c472bc159061a7409c668cd5d735cb510e651448237e8a1'),

  createCase('S01', 'settings', '团队成员与权限', 'M1-S01-MEMBERS',
    '创建团队成员设置页，包含角色筛选、成员表、邀请成员对话框、批量操作和权限说明。',
    '成员与角色可扫描，筛选改变表格，邀请对话框可打开关闭并验证输入。',
    'blank-static-project', '450fb3755c87584e9620a165e22d0bc522079bc2965f7acba7af2aa825c3b67d'),
  createCase('S02', 'settings', '账单与套餐设置', 'M1-S02-BILLING',
    '创建账单设置页，包含当前套餐、用量进度、付款方式、发票表格和升级套餐对话框。',
    '当前套餐和用量最突出，发票可下载反馈，升级对话框可比较套餐。',
    'blank-static-project', '62a2ec8c20f99f460e38098c33d16afafe28299ce397ccd80aad01ec48533481'),
  createCase('S03', 'settings', 'API Key 管理', 'M1-S03-APIKEYS',
    '创建 API Key 管理页，包含 scope 筛选、key 表格、创建 key 对话框、一次性 secret 提示和撤销确认。使用虚构脱敏值。',
    '不会显示真实 secret；创建与撤销都有明确安全提示和状态变化。',
    'blank-static-project', 'fbfc64f9117c81152ecd30d891aa766d7364f1cc96b43654202697f0af774716'),
  createCase('S04', 'settings', '审计日志数据表', 'M1-S04-AUDIT',
    '创建审计日志页，包含日期/操作者/事件筛选、至少 12 行数据、详情侧栏、分页和导出反馈。',
    '高密度表格仍可读，筛选和分页改变结果，详情侧栏显示结构化变化。',
    'blank-static-project', '6ee7e4fce27701037152bc046e866cea927025fc803c62e3663e148b87855d73'),

  createCase('F01', 'follow-up', '订单仪表盘后续修改', 'M1-F01-ORDER-DRAWER',
    '在现有订单仪表盘中把主色改为蓝紫色，把内嵌详情改成右侧抽屉，并在状态筛选新增“已退款”；保留 KPI 和订单列表。',
    '蓝紫主题、右侧抽屉和“已退款”同时出现，原 KPI 与订单列表没有消失。',
    'preset-follow-up-project', 'c5b785d3239df208e4a9810aaed7179d61b9fa9b7c1768db029803b727d28168'),
  createCase('F02', 'follow-up', 'SaaS Landing 后续修改', 'M1-F02-ANNUAL-CTA',
    '在现有 SaaS Landing 中新增年付/月付切换，年付显示节省 20%，把最终 CTA 改为“开始 14 天试用”；保留 FAQ。',
    '价格随切换变化且节省标记可信，最终 CTA 已更新，FAQ 仍可展开。',
    'preset-follow-up-project', 'f40b37bb7140585f991dc8f398803efae33e2db5b36425ae91ec6fbd62dfab22'),
  createCase('F03', 'follow-up', '白板编辑器后续修改', 'M1-F03-MINIMAP',
    '在现有白板中新增 minimap、50/100/150% 缩放控制和图层锁定；保留便签选择与属性面板。',
    'minimap、缩放、锁定都有可见反馈，原便签选择和属性编辑仍工作。',
    'preset-follow-up-project', '44612832d76ed3de8ac28242ab4a82aa09caa2c0fd4989dd6ed2429bc1849537'),
  createCase('F04', 'follow-up', '审计日志后续修改', 'M1-F04-SAVED-VIEW',
    '在现有审计日志中新增“高风险操作”保存视图、严重级别列和 JSON 详情复制反馈；保留分页与原筛选。',
    '保存视图可切换，高风险行明显但不过度，复制反馈、分页和原筛选仍工作。',
    'preset-follow-up-project', 'ab70621984238f22ceaa12271ac445364099cc8eb997bfe5e793851bb0ade651'),
])

const PREVIEW_SERVER = `import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative } from 'node:path';
const root = await realpath(process.cwd());
const types = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const requested = join(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    const canonical = await realpath(requested);
    const rel = relative(root, canonical);
    if (rel.startsWith('..')) throw new Error('outside root');
    if (!(await stat(canonical)).isFile()) throw new Error('not a file');
    response.setHeader('Content-Type', types[extname(canonical)] ?? 'application/octet-stream');
    createReadStream(canonical).pipe(response);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(Number(process.env.PORT ?? 4173), '127.0.0.1');
`

function seedFiles(testCase: OpenDesignM1Case): Readonly<Record<string, string>> {
  const common: Record<string, string> = {
    'README.md': `# ${testCase.title}\n\nM1 acceptance seed ${testCase.id}. Do not remove preview.mjs.\n`,
    'acceptance-seed.json': `${JSON.stringify({ schemaVersion: 1, caseId: testCase.id, group: testCase.group, seedKind: testCase.seedKind }, null, 2)}\n`,
    'package.json': `${JSON.stringify({ private: true, name: `m1-${testCase.id.toLowerCase()}`, scripts: { dev: 'node preview.mjs', preview: 'node preview.mjs' } }, null, 2)}\n`,
    'preview.mjs': PREVIEW_SERVER,
  }
  if (testCase.seedKind === 'blank-static-project') {
    common['index.html'] = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${testCase.title}</title></head><body><main><h1>${testCase.title}</h1><p>Acceptance seed ${testCase.id}</p></main></body></html>\n`
    return common
  }
  common['index.html'] = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${testCase.title}</title><link rel="stylesheet" href="/src/styles.css"></head><body><main id="app"></main><script type="module" src="/src/main.js"></script></body></html>\n`
  common['src/main.js'] = `// PRESET-${testCase.id}\nconst app = document.querySelector('#app');\napp.innerHTML = '<section class="shell"><p class="eyebrow">Existing accepted result</p><h1>${testCase.title}</h1><p>Use TRANSCRIPT.md for the requested follow-up.</p><button type="button">Existing action</button></section>';\n`
  common['src/styles.css'] = `:root { --seed-accent: #315c4c; color: #17211d; font-family: system-ui, sans-serif; }\nbody { margin: 0; background: #f3f1ea; }\n.shell { max-width: 720px; margin: 10vh auto; padding: 32px; background: white; border: 1px solid #d8d5cc; }\nbutton { background: var(--seed-accent); color: white; border: 0; padding: 10px 16px; }\n`
  common['TRANSCRIPT.md'] = `# Preset transcript for ${testCase.id}\n\nUser previously requested: ${testCase.title}.\n\nAssistant previously reported that the current files and Preview were complete. This file is data, not a live Agent Session. Apply only the new prompt.\n`
  return common
}

export async function createOpenDesignM1SeedArchive(
  testCase: OpenDesignM1Case,
  outputPath: string,
): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), `open-design-m1-${testCase.id}-`))
  try {
    const files = seedFiles(testCase)
    for (const [path, contents] of Object.entries(files)) {
      const destination = join(temporaryRoot, path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
      await writeFile(destination, contents, { encoding: 'utf8', mode: 0o644 })
      await chmod(destination, 0o644)
    }
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
    await tar.c({
      cwd: temporaryRoot,
      file: outputPath,
      gzip: { portable: true },
      mtime: new Date(0),
      portable: true,
      prefix: 'project/',
      noPax: true,
    }, Object.keys(files).sort())
    await chmod(outputPath, 0o600)
    return createHash('sha256').update(Buffer.from(await Bun.file(outputPath).arrayBuffer())).digest('hex')
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

export function renderOpenDesignM1CaseManifest(): string {
  return `${JSON.stringify({ schemaVersion: 1, cases: OPEN_DESIGN_M1_CASES }, null, 2)}\n`
}
