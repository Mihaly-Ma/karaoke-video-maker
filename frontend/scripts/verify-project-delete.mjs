// 用法：在 frontend 下运行 node scripts/verify-project-delete.mjs。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch()
    try {
      const page = await browser.newPage()
      page.on('pageerror', (error) => console.error(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') console.error(message.text())
      })
      await page.addInitScript(() => {
        window.confirm = () => {
          throw new Error('WebView 不支持原生确认框')
        }
      })
      let deleted = false
      let fail = true
      let requests = 0
      const summary = {
        id: 'delete-test',
        title: '删除测试',
        artist: '',
        updated_at: 0,
        duration_ms: 0,
        line_count: 0,
      }
      await page.route('**/api/**', async (route) => {
        const request = route.request()
        const pathname = new URL(request.url()).pathname
        if (!pathname.startsWith('/api/')) return route.continue()
        if (request.method() === 'DELETE') {
          requests++
          if (fail) return route.fulfill({ status: 500, json: { detail: '删除失败测试' } })
          deleted = true
          return route.fulfill({ json: { ok: true } })
        }
        const json =
          pathname === '/api/projects/'
            ? deleted
              ? []
              : [summary]
            : { ...summary, lines: [], credits: [], exports: [], palettes: {} }
        await route.fulfill({ json })
      })
      await page.goto(server.resolvedUrls.local[0])
      const button = page.getByRole('button', { name: '删除工程', exact: true })
      await button.click()
      const dialog = page.getByRole('dialog')
      await dialog.waitFor()
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(requests, 0)
      await button.focus()
      await page.keyboard.press('Enter')
      await dialog.waitFor()
      assert(await page.getByRole('heading', { name: '卡拉OK 视频制作', exact: true }).isVisible())
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(requests, 0)
      await button.click()
      await dialog.getByRole('button', { name: '删除工程', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await page.getByText('删除工程失败：删除失败测试', { exact: true }).waitFor()
      assert.equal(requests, 1)
      assert(await page.getByText('删除测试', { exact: true }).isVisible())
      fail = false
      await button.click()
      await dialog.getByRole('button', { name: '删除工程', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await page.getByText('0 个工程', { exact: true }).waitFor()
      assert.equal(requests, 2)
      console.log(`${engine.name()}：取消、键盘操作、失败重试与删除通过`)
    } finally {
      await browser.close()
    }
  }
} finally {
  await server.close()
}
