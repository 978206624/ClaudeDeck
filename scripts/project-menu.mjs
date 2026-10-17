/** npm run build && node scripts/project-menu.mjs
 * 真实主进程/桥接/React 的项目菜单回归,独立临时配置,不调用模型。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { _electron as electron } from 'playwright'

const ROOT = resolve(import.meta.dirname, '..')
const TEMP = mkdtempSync(join(tmpdir(), 'claudedeck-projects-'))
const WORKSPACE = join(TEMP, 'project-a')
const OTHER = join(TEMP, 'project-b')
const USER_DATA = join(TEMP, 'user-data')
const CONFIG = join(USER_DATA, 'config.json')
for (const dir of [WORKSPACE, OTHER, USER_DATA]) mkdirSync(dir)
writeFileSync(join(WORKSPACE, 'CLAUDE.md'), '# 未保存保护\n')
writeFileSync(join(OTHER, 'keep.txt'), '不能删除')
writeFileSync(CONFIG, JSON.stringify({
  projects: [{ path: WORKSPACE, name: '项目A', collapsed: false },
    { path: OTHER, name: '项目B', collapsed: false }], activeWorkspace: WORKSPACE,
}))
const ENTRY = join(TEMP, 'main.cjs')
await build({
  entryPoints: [join(ROOT, 'src/main/index.ts')], outfile: ENTRY,
  bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(ENTRY).href) },
  banner: { js: `require = require('node:module').createRequire(${JSON.stringify(join(ROOT, 'package.json'))});` },
  plugins: [{ name: 'project-fixtures', setup(builder) {
    builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({
      path: join(ROOT, 'scripts/fixtures/session-sdk.mjs'),
    }))
    builder.onResolve({ filter: /^\.\/doctor\.js$/ }, () => ({ path: 'doctor', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      `export const runDoctor = async () => ({cliFound:true,credentialsConfigured:true});
       export const installCli = async () => ({ok:true,output:''});`,
    }))
    builder.onLoad({ filter: /src[\\/]main[\\/]index\.ts$/ }, ({ path }) => ({
      loader: 'ts', contents: readFileSync(path, 'utf8')
        .replace("join(__dirname, '../preload/index.mjs')", JSON.stringify(join(ROOT, 'out/preload/index.mjs')))
        .replace('mainWindow?.show()', 'undefined'),
    }))
  } }],
})
const server = await createServer({
  configFile: false, root: join(ROOT, 'src/renderer'), plugins: [react()],
  server: { host: '127.0.0.1', port: 0, fs: { allow: [ROOT] } },
})
let app
try {
  await server.listen()
  const launch = () => electron.launch({
    args: [ENTRY, `--user-data-dir=${USER_DATA}`], cwd: ROOT,
    env: { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${server.httpServer.address().port}`,
      CLAUDEDECK_TEST_REPORT: join(TEMP, 'closed.json'), CLAUDEDECK_TEST_WORKSPACE: WORKSPACE },
  })
  app = await launch()
  let page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  // 按显示名称定位,避免 Windows 路径的 CSS 转义歧义。
  const project = (name) => page.locator('.project-row').filter({ hasText: name })
  const ready = () => page.waitForFunction(() =>
    document.querySelector('.composer-wrap')?.getAttribute('aria-busy') === 'false')
  const menu = () => page.locator('.project-menu')
  const openMenu = async (name) => {
    await project(name).click({ button: 'right' })
    await menu().waitFor()
  }
  await project('项目A').waitFor()
  await ready()
  const original = await page.evaluate(() => window.api.config.get())
  await openMenu('项目B')
  const after = await page.evaluate(() => window.api.config.get())
  assert.deepEqual(after, original)
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), '移除项目')
  await page.keyboard.press('Escape')
  assert.equal(await project('项目B').evaluate((el) => el === document.activeElement), true)
  await project('项目B').press('Shift+F10')
  await menu().getByRole('menuitem', { name: '编辑项目' }).click()
  assert.equal(await page.locator('#project-path').inputValue(), OTHER)
  assert.equal(await page.locator('#project-path').getAttribute('readonly'), '')
  await page.locator('#project-name').fill('   ')
  assert.equal(await menu().getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  await page.locator('#project-name').fill('  中文项目 B  ')
  await menu().getByRole('button', { name: '保存', exact: true }).click()
  await project('中文项目 B').waitFor()
  const stored = JSON.parse(readFileSync(CONFIG, 'utf8'))
  assert.deepEqual(stored.projects[1], { ...original.projects[1], name: '中文项目 B' })
  assert.equal(stored.activeWorkspace, WORKSPACE)
  for (const args of [[OTHER, ''], [OTHER, 12], [123, '名称'], [join(TEMP, 'unknown'), '名称']]) {
    const rejected = await page.evaluate(async ([path, name]) => {
      try { await window.api.projects.rename(path, name); return false } catch { return true }
    }, args)
    assert.equal(rejected, true)
  }
  assert.deepEqual(JSON.parse(readFileSync(CONFIG, 'utf8')), stored)
  console.log('PASS 右键不切换/折叠,键盘导航与焦点,空白/非法参数校验,名称保存不改目录')

  await app.close()
  app = await launch()
  page = await app.firstWindow()
  page.on('pageerror', (err) => errors.push(err.message))
  await project('中文项目 B').waitFor()
  await ready()
  assert.equal(await page.evaluate(() => window.api.config.get().then((c) => c.projects[1].name)), '中文项目 B')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(async (theme) => { await window.api.config.update({ theme });
      document.documentElement.dataset.theme = theme }, theme)
    for (const width of [940, 1200, 1600]) {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('.project-row').first().evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: innerWidth - 1, clientY: innerHeight - 1,
      })))
      await menu().waitFor()
      await menu().getByRole('menuitem', { name: '编辑项目' }).click()
      const bounds = await menu().evaluate((el) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          width: innerWidth, height: innerHeight, style: el.getAttribute('style') }
      })
      const inside = bounds.left >= 7.5 && bounds.top >= 7.5 && bounds.right <= bounds.width - 7.5
        && bounds.bottom <= bounds.height - 7.5 && bounds.left > bounds.width / 2 && bounds.top > bounds.height / 2
      assert.equal(inside, true, `${theme} ${width}px 菜单未贴近右下角或溢出:${JSON.stringify(bounds)}`)
      if (width === 1200) await page.screenshot({ path: join(TEMP, `project-edit-${theme}.png`) })
      await page.keyboard.press('Escape')
    }
  }
  await page.setViewportSize({ width: 1200, height: 800 })
  console.log('PASS 重启后名称持久化,亮暗主题与窗口边缘不裁切')

  await page.locator('.session-row[title="测试会话A"]').click()
  await ready()
  await page.locator('.composer textarea').fill('A持续运行')
  await page.locator('.composer [data-state="send"]').click()
  await page.locator('.session-row[title="测试会话C"]').click()
  await ready()
  await page.locator('.composer textarea').fill('C持续运行')
  await page.locator('.composer [data-state="send"]').click()
  await page.locator('.session-row[title="测试会话A"]').click()
  await ready()
  await page.locator('.composer textarea').fill('保留输入草稿')
  await openMenu('中文项目 B')
  await menu().getByRole('menuitem', { name: '移除项目' }).click()
  assert.equal(await menu().getByText('只从项目列表移除', { exact: false }).count(), 1)
  await menu().getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await project('中文项目 B').count(), 1)
  await openMenu('中文项目 B')
  await menu().getByRole('menuitem', { name: '移除项目' }).click()
  await menu().getByRole('button', { name: '移除', exact: true }).click()
  await project('中文项目 B').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.composer textarea').inputValue(), '保留输入草稿')
  assert.equal(await page.locator('.session-row[aria-current="true"]').getAttribute('title'), '测试会话A')
  const stats = await app.evaluate(() => globalThis.sessionFixture.instances.map((q) => ({ id: q.id, closed: q.closed })))
  assert.equal(stats.findLast((q) => q.id === 'A').closed, false)
  assert.equal(stats.findLast((q) => q.id === 'C').closed, true)
  await app.evaluate(() => globalThis.sessionFixture.instances.findLast((q) => q.id === 'A' && !q.closed).push({
    type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '移除其他项目后A仍在输出' } },
  }))
  await page.locator('.msg-claude').filter({ hasText: '移除其他项目后A仍在输出' }).waitFor()
  assert.equal(readFileSync(join(OTHER, 'keep.txt'), 'utf8'), '不能删除')
  console.log('PASS 取消不移除,移除非当前项目保留当前对话/草稿,仅清理目标会话,目录保留')

  // 模拟系统目录选择,重新登记相同目录,历史仍可见。
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, OTHER)
  await page.getByTitle('添加项目', { exact: true }).click()
  await project('project-b').waitFor()
  await page.locator('.session-row[title="测试会话C"]').waitFor()
  await page.locator('.session-row[title="测试会话A"]').click()
  await ready()
  await page.getByTitle('浏览 项目A 的文件').click()
  await page.locator('.file-row').filter({ hasText: 'CLAUDE.md' }).click()
  await page.getByRole('button', { name: '编辑源码', exact: true }).click()
  await page.locator('.midcol textarea').fill('# 不可丢弃的草稿')
  await openMenu('项目A')
  await menu().getByRole('menuitem', { name: '移除项目' }).click()
  await menu().getByRole('button', { name: '移除', exact: true }).click()
  await menu().getByRole('alert').waitFor()
  assert.equal(await project('项目A').count(), 1)
  assert.equal(await page.locator('.midcol textarea').inputValue(), '# 不可丢弃的草稿')
  await page.keyboard.press('Escape')
  await page.locator('.midcol-head button[title="关闭"]').click()
  await page.getByRole('button', { name: '不保存', exact: true }).click()
  console.log('PASS 未保存文件阻止移除并保留草稿,重新登记目录后历史仍可见')

  await openMenu('项目A')
  await menu().getByRole('menuitem', { name: '移除项目' }).click()
  await menu().getByRole('button', { name: '移除', exact: true }).click()
  await project('项目A').waitFor({ state: 'hidden' })
  await ready()
  assert.equal(await page.evaluate(() => window.api.config.get().then((c) => c.activeWorkspace)), OTHER)
  assert.equal(await page.locator('.session-row[aria-current="true"]').count(), 0)
  await openMenu('project-b')
  await menu().getByRole('menuitem', { name: '移除项目' }).click()
  await menu().getByRole('button', { name: '移除', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('.sidebar') && !document.querySelector('.composer'))
  assert.deepEqual(await page.evaluate(() => window.api.config.get().then((c) => c.projects)), [])
  assert.equal(existsSync(join(WORKSPACE, 'CLAUDE.md')), true)
  assert.deepEqual(errors, [])
  console.log('PASS 当前项目移除切到剩余项目的新会话,最后一个移除返回选择页,无渲染错误')
  console.log(`截图与测试数据: ${TEMP}`)
} finally {
  await app?.close()
  await server.close()
}
