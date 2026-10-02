import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium, webkit } from 'playwright'
import { createServer } from 'vite'

const fixture = JSON.parse(execFileSync('uv', ['run', '--no-sync', 'python', '-c', `
import sys
sys.path.insert(0, 'backend')
from kvm.api.schemas import ProjectDTO, LineDTO, TokenDTO, RubySpanDTO
p = ProjectDTO(id='selection-test', title='编辑验收', duration_ms=10000, audio_path='fixture.wav', instrumental_path='instrumental.wav', vocals_path='vocals.wav', guide_audio_path='guide.wav', lines=[
    LineDTO(id='L1', tokens=[TokenDTO(text=c, start_ms=1000+i*300, dur_ms=300) for i,c in enumerate('桜舞って')], ruby=[RubySpanDTO(start=0,end=1,text='さくら'),RubySpanDTO(start=1,end=2,text='ま')]),
    LineDTO(id='L2', tokens=[TokenDTO(text=c, start_ms=3000+i*300, dur_ms=300) for i,c in enumerate('今日')], ruby=[RubySpanDTO(start=0,end=2,text='きょう')]),
])
print(p.model_dump_json())
`], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' }))
const sampleRate = 16000, sampleCount = sampleRate * 10
const audio = Buffer.alloc(44 + sampleCount * 2)
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28)
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36)
audio.writeUInt32LE(sampleCount * 2, 40)
for (let i = 0; i < sampleCount; i++) {
  const amplitude = (0.3 + 0.7 * Math.sin(i / sampleRate * 3) ** 2) * 3000
  audio.writeInt16LE(Math.round(Math.sin(i / sampleRate * Math.PI * 440) * amplitude), 44 + i * 2)
}
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 } })
await server.listen()
try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      const errors = [], shifts = [], moraRequests = []
      page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message) })
      const project = structuredClone(fixture)
      await page.addInitScript(() => localStorage.setItem('kvm.step.selection-test', 'edit'))
      await page.route('**/api/**', async (route) => {
        const request = route.request(), path = new URL(request.url()).pathname
        if (!path.startsWith('/api/')) return route.continue()
        if (path.startsWith('/api/media/file/')) return route.fulfill({ contentType: 'audio/wav', body: audio })
        if (path === '/api/editor/mora-timings') {
          moraRequests.push(request.postDataJSON())
          if (moraRequests.length === 1) return route.fulfill({ status: 400, json: { detail: '保存失败测试' } })
          return route.fulfill({ json: project })
        }
        if (path === '/api/editor/shift-selection') {
          const body = request.postDataJSON(); shifts.push(body)
          for (const range of body.ranges) {
            const line = project.lines.find((l) => l.id === range.line_id)
            for (const token of line.tokens.slice(range.start, range.end)) token.start_ms += body.delta_ms
          }
          return route.fulfill({ json: project })
        }
        const json = path === '/api/projects/' ? [{ ...project, line_count: 2 }]
          : path.endsWith('/history') ? { undo: shifts.length, redo: 0 }
          : path.startsWith('/api/media/activity/') || path.startsWith('/api/render/exports/') || path.startsWith('/api/fonts/') ? [] : project
        await route.fulfill({ json })
      })
      await page.goto(server.resolvedUrls.local[0])
      await page.getByRole('button', { name: /编辑验收/ }).click()
      const preview = page.locator('.edit-preview')
      const vocal = preview.getByTestId('mix-layer-vocals')
      await vocal.waitFor({ state: 'visible' })
      await page.waitForFunction(() => !document.querySelector('[data-testid="mix-layer-vocals"]').disabled)
      await vocal.click()
      assert.equal(await vocal.getAttribute('aria-pressed'), 'true')
      await vocal.click()
      assert.equal(await vocal.getAttribute('aria-pressed'), 'false')
      await preview.getByTestId('volume-toggle').click()
      assert.equal(await preview.getByTestId('volume-toggle').getAttribute('aria-expanded'), 'true')
      await preview.getByTestId('volume-toggle').click()
      const toolbar = page.locator('.kvm-ruby__bar')
      assert(await toolbar.getByRole('button', { name: '编辑歌词', exact: true }).isVisible())
      assert(await page.locator('[data-role="reading"]').isVisible())
      assert(await page.locator('[data-role="voice-part"]').isVisible())
      assert(await toolbar.locator('[data-role="split"]').isVisible())
      assert.equal(await page.locator('.kvm-tl [data-role="split"]').count(), 0)
      await toolbar.getByRole('button', { name: '编辑歌词', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
      const from = await page.locator('.kvm-ruby__line[data-line="L1"] .kvm-ruby__ch[data-tk="1"]').boundingBox()
      const to = await page.locator('.kvm-ruby__line[data-line="L2"] .kvm-ruby__ch[data-tk="0"]').boundingBox()
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
      await page.mouse.up()
      const timing = page.locator('[data-role="selection-timing"]')
      await timing.getByText('已选 4 字', { exact: true }).waitFor()
      assert.equal(await page.locator('[data-role="token-start"]').count(), 0)
      await timing.getByRole('button', { name: '+100', exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('[data-role="selection-timing"] button:disabled'))
      assert.deepEqual(shifts[0].ranges, [{ line_id: 'L1', start: 1, end: 4 }, { line_id: 'L2', start: 0, end: 1 }])
      assert.equal(shifts[0].delta_ms, 100)
      await timing.getByRole('spinbutton').fill('-50')
      await timing.getByRole('spinbutton').press('Enter')
      await page.waitForFunction(() => !document.querySelector('[data-role="selection-timing"] button:disabled'))
      assert.equal(shifts[1].delta_ms, -50)
      await page.screenshot({ path: `/tmp/kvm-edit-overview-${engine.name()}.png` })
      await page.locator('.kvm-ruby__line[data-line="L2"] .kvm-ruby__ch[data-tk="0"]').click()
      await page.getByRole('combobox', { name: '手工打轴方式' }).selectOption('mora')
      await page.locator('[data-role="tap"]').click()
      const mora = page.locator('[data-role="mora-tap"]')
      await mora.getByText('きょ', { exact: true }).waitFor()
      const seek = async (time) => page.evaluate(async (ms) => {
        const { useProject } = await import('/src/state/projectStore.ts')
        useProject.getState().setPlayhead(ms)
      }, time)
      await seek(4000); await page.keyboard.press('Space')
      await seek(4200); await page.keyboard.press('Space')
      await page.keyboard.press('Backspace')
      await seek(4300); await page.keyboard.press('Space')
      await seek(4700); await page.keyboard.press('Shift+Space')
      await page.screenshot({ path: `/tmp/kvm-edit-mora-${engine.name()}.png` })
      await mora.getByRole('button', { name: '提交', exact: true }).click()
      await mora.getByRole('alert').getByText('保存失败测试').waitFor()
      assert.equal(moraRequests[0].items.length, 1)
      assert.deepEqual(moraRequests[0].items[0].times, [{ text: 'きょ', start_ms: 4000, dur_ms: 300 }, { text: 'う', start_ms: 4300, dur_ms: 400 }])
      await mora.getByRole('button', { name: '保存并退出' }).click()
      await mora.waitFor({ state: 'detached' })
      assert.equal(moraRequests.length, 2)
      await page.setViewportSize({ width: 1024, height: 768 })
      assert(await toolbar.getByRole('button', { name: '编辑歌词', exact: true }).isVisible())
      const options = page.locator('[data-role="timing-options"]')
      assert(!await page.locator('[data-role="global-offset"]').isVisible())
      await options.locator('summary').click()
      assert(await page.locator('[data-role="global-offset"]').isVisible())
      await options.locator('summary').click()
      await page.screenshot({ path: `/tmp/kvm-edit-${engine.name()}.png` })
      assert.deepEqual(errors, [])
      console.log(`${engine.name()}：默认注音声部、跨行移动、注音打轴、回退与失败重试通过`)
    } finally { await browser.close() }
  }
} finally { await server.close() }
