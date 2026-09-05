/**
 * 测试栈：一个与日常使用完全隔离的 harness，用于验证 dsh-notion-mcp 插件
 * 与 harness v0.1.2-rc.1 的兼容性。
 *
 * dsh-notion 是纯 host 插件（无 client bundle），不需要 Chrome。
 * 测试只需验证：
 * 1. 隔离的 DSH_HOME 能正常启动 harness
 * 2. 插件被正确加载（日志中出现 [dsh-notion-mcp] 输出）
 * 3. 无 "declares no dsh.bundle" 警告
 *
 * v0.1.2-rc.1 引入了 token 认证：首次访问 /?token=XXX 设置 cookie，
 * 后续请求需要带 cookie 才能拿到 200 + __DSH_BOOT__。
 *
 * 用法：
 *   node scripts/test-stack.mjs up       同步副本、启动 harness
 *   node scripts/test-stack.mjs down     停掉 harness
 *   node scripts/test-stack.mjs status   报告存活与就绪情况
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 日常在用的那个 harness 的端口——测试栈绝不能起在它上面。 */
const RESERVED_PORT = 3080

const HARNESS_PORT = 3182
const PAGE_URL = `http://127.0.0.1:${HARNESS_PORT}/`

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-notion-mcp'
const REAL_HOME = join(homedir(), '.dsh')
const TEST_HOME = join(REPO, 'tmp/dsh-notion-test-home')
const STATE_DIR = join(REPO, 'tmp/dsh-notion-stack')
const HARNESS_LOG = join(STATE_DIR, 'harness.log')
const HARNESS_PID = join(STATE_DIR, 'harness.pid')

/** 产品自带的 node。Electron 那份跑不了 harness 的原生模块。 */
const NODE_BIN = join(REAL_HOME, 'desktop-bin/node-shim/node')

/** @param {string} message */
function die(message) {
  console.error(`[test-stack] ${message}`)
  process.exit(1)
}

if (Number.parseInt(process.versions.node.split('.')[0], 10) < 20) {
  die(`需要 node 20+，当前 ${process.version}。`)
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 读一个 pid 文件，确认进程还活着。
 * @param {string} file
 * @returns {number | null}
 */
function readPid(file) {
  if (!existsSync(file)) return null
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

/**
 * 停掉一个进程，先核对命令行。
 * @param {string} file pid 文件
 * @param {string} marker 命令行里必须出现的片段
 * @param {string} label 打印用的名字
 */
async function stopProcess(file, marker, label) {
  const pid = readPid(file)
  if (pid === null) {
    console.log(`[test-stack] ${label}: 没有在跑`)
    rmSync(file, { force: true })
    return
  }
  let cmdline = ''
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch {
    rmSync(file, { force: true })
    return
  }
  if (!cmdline.includes(marker)) {
    console.log(`[test-stack] ${label}: pid ${pid} 已被系统回收（命令行对不上），不发信号`)
    rmSync(file, { force: true })
    return
  }
  process.kill(pid, 'SIGTERM')
  for (let i = 0; i < 50; i += 1) {
    if (readPid(file) === null) break
    await sleep(100)
  }
  const still = readPid(file)
  if (still !== null) process.kill(still, 'SIGKILL')
  rmSync(file, { force: true })
  console.log(`[test-stack] ${label}: 已停（pid ${pid}）`)
}

/**
 * 端口上有没有东西在答话。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return true
  } catch (error) {
    if (error.name === 'TimeoutError') return true
    if (!(error instanceof TypeError)) throw error
    const codes = [error.cause?.code, ...(error.cause?.errors ?? []).map((e) => e.code)]
    if (codes.includes('ECONNREFUSED')) return false
    throw error
  }
}

/**
 * 把真 home 同步成副本。首次全量，之后只搬变化的部分。
 * 凭据和锁文件不进副本。
 */
function syncHome() {
  if (!existsSync(REAL_HOME)) die(`找不到 ${REAL_HOME}`)
  mkdirSync(TEST_HOME, { recursive: true })
  const args = [
    '-a', '--delete',
    '--exclude=.credentials.yaml',
    '--exclude=.credentials.yaml.*',
    '--exclude=*.sock', '--exclude=*.lock',
    `${REAL_HOME}/`, `${TEST_HOME}/`,
  ]
  const res = spawnSync('rsync', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (res.error !== undefined) die(`rsync 起不来：${res.error.message}`)
  if (res.status !== 0) die(`rsync 失败（退出码 ${res.status}）`)

  // rsync --delete + --exclude 排除了真 home 里的文件，但 harness 上次运行时在
  // 副本里创建的锁文件不会被 rsync 删掉（它们在真 home 里不存在，--delete 不管）。
  // 必须显式清理：原子写入锁超时是 harness 启动失败的常见根因。
  for (const pattern of ['.credentials.yaml.lock', '.credentials.yaml']) {
    const f = join(TEST_HOME, pattern)
    if (existsSync(f)) rmSync(f, { force: true })
  }

  console.log(`[test-stack] 副本已同步：${TEST_HOME}`)
}

/**
 * 移除副本 node_modules 中所有指向不存在路径的软链，防止 harness 启动时崩溃。
 */
function cleanBrokenLinks() {
  const modules = join(TEST_HOME, 'profiles/web/node_modules')
  let cleaned = 0
  let entries
  try {
    entries = readdirSync(modules, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isSymbolicLink()) continue
    const fullPath = join(modules, entry.name)
    try {
      readFileSync(join(fullPath, 'package.json'), 'utf8')
    } catch {
      console.log(`[test-stack] 清理断链：${entry.name}`)
      rmSync(fullPath, { force: true })
      cleaned++
    }
  }

  // 检查 scope 目录下的软链
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      const scopeDir = join(modules, entry.name)
      try {
        const subEntries = readdirSync(scopeDir, { withFileTypes: true })
        for (const sub of subEntries) {
          if (!sub.isSymbolicLink()) continue
          const subPath = join(scopeDir, sub.name)
          try {
            readFileSync(join(subPath, 'package.json'), 'utf8')
          } catch {
            console.log(`[test-stack] 清理断链：${entry.name}/${sub.name}`)
            rmSync(subPath, { force: true })
            cleaned++
          }
        }
      } catch {}
    }
  }
  if (cleaned > 0) console.log(`[test-stack] 清理了 ${cleaned} 个断链`)
}

/**
 * 把副本里指向本仓库的插件软链重新指对。
 */
function relinkPlugin() {
  const modules = join(TEST_HOME, 'profiles/web/node_modules')
  mkdirSync(modules, { recursive: true })

  const link = join(modules, PLUGIN_NAME)
  rmSync(link, { force: true })
  symlinkSync(REPO, link)
  console.log(`[test-stack] 插件软链已重写：${link} -> ${REPO}`)
}

/**
 * 把副本 profile 的 manifest 改成只包含 dsh-notion-mcp 插件。
 *
 * 测试栈只验证本插件，保留其他第三方插件可能导致 harness 启动失败
 * （副本 node_modules 中的软链指向不存在的路径）。
 */
function fixManifest() {
  const path = join(TEST_HOME, 'profiles/web/package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))

  // 只保留内置 bundle 和本插件；本插件的依赖无条件写入（真 home 可能没装过它）
  manifest.dependencies = { [PLUGIN_NAME]: `link:${REPO}` }

  const bundles = manifest.dsh?.profile?.bundles ?? []
  const keepBundles = bundles.filter((b) => b.startsWith('@deepseek-ai/') || b === PLUGIN_NAME)
  if (!keepBundles.includes(PLUGIN_NAME)) keepBundles.push(PLUGIN_NAME)
  manifest.dsh.profile.bundles = keepBundles

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[test-stack] profile manifest 已修正：仅保留内置 bundles + ${PLUGIN_NAME}`)
}

/**
 * harness 的入口。
 *
 * 两个候选按「离用户实际跑的那份最近」排序：dsh-desktop 打包的 CLI 是产品自带的
 * 那个——也就是 3080 上正在服务的同一份；解析不到才回落到 npm 依赖。
 */
function harnessBin() {
  const candidates = [
    join(REPO, '../dsh-desktop/dist/desktop/dsh-linux-x64/resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    join(REAL_HOME, 'profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]
  for (const bin of candidates) {
    if (existsSync(bin)) return bin
  }
  die(`找不到 @deepseek-ai/dsh/lib/bin.js（试过 ${candidates.join('、')}）`)
}

/** 起 harness，等到首页答 200 且带插件名册。 */
async function startHarness() {
  if (await portBusy(HARNESS_PORT)) die(`${HARNESS_PORT} 已被占用，先 npm run stack:down`)
  if (!existsSync(NODE_BIN)) die(`找不到产品自带的 node：${NODE_BIN}`)

  // 用 sh wrapper 脚本 + detached 启动 harness。
  // wrapper 脚本用 exec 替换 shell，所以 child.pid 就是 harness 的 PID。
  const wrapperScript = join(STATE_DIR, 'start-harness.sh')
  writeFileSync(wrapperScript, `#!/bin/sh
export DSH_HOME="${TEST_HOME}"
exec "${NODE_BIN}" --expose-internals "${harnessBin()}" --profile web --port ${HARNESS_PORT} --no-open
`)
  const log = openSync(HARNESS_LOG, 'w')
  const child = spawn('sh', [wrapperScript], {
    stdio: ['ignore', log, log],
    detached: true,
  })
  child.unref()
  writeFileSync(HARNESS_PID, String(child.pid))
  console.log(`[test-stack] harness 启动中：pid=${child.pid} port=${HARNESS_PORT} DSH_HOME=${TEST_HOME}`)

  for (let i = 0; i < 120; i += 1) {
    await sleep(500)

    // 先检查致命错误，快速失败
    const logContent = readFileSync(HARNESS_LOG, 'utf8')
    if (logContent.includes('plugin tree failed to load')) {
      die(`harness 插件加载失败，日志：\n${logContent}`)
    }

    // v0.1.2-rc.1 引入 token 认证：首次访问 /?token=XXX 设置 cookie，后续带 cookie 才能拿到 200。
    // 先从日志中提取 token，然后用 curl cookie jar 跟踪重定向。
    const tokenMatch = logContent.match(/\?token=([A-Za-z0-9_-]+)/)
    if (!tokenMatch) continue
    const token = tokenMatch[1]

    let html = ''
    try {
      // 第一步：访问 /?token=XXX 触发 303 重定向 + Set-Cookie
      // 第二步：跟随重定向到 /，带 cookie 拿到 200 + __DSH_BOOT__
      // 用 AbortSignal timeout 防止无限等待。
      const cookieRes = await fetch(`${PAGE_URL}?token=${token}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1500),
      })
      // 303 重定向带 Set-Cookie
      const setCookie = cookieRes.headers.get('set-cookie') ?? ''
      const location = cookieRes.headers.get('location') ?? '/'
      if (!setCookie && cookieRes.status !== 200) continue

      // 用 cookie 访问实际页面
      const pageRes = await fetch(`http://127.0.0.1:${HARNESS_PORT}${location}`, {
        headers: setCookie ? { Cookie: setCookie.split(';')[0] } : {},
        signal: AbortSignal.timeout(1500),
      })
      if (!pageRes.ok) continue
      html = await pageRes.text()
    } catch {
      continue
    }
    if (!html.includes('__DSH_BOOT__')) continue

    // dsh-notion 是纯 host 插件，不出现在 __DSH_BOOT__ 的 client entries 中。
    // 通过日志中的插件输出确认 apply() 被调用了。
    const pluginLoaded = logContent.includes('[dsh-notion-mcp]')
    console.log(`[test-stack] harness 就绪：${PAGE_URL} 插件已加载=${pluginLoaded}`)

    const bundleWarning = logContent.includes('declares no dsh.bundle')
    if (bundleWarning) {
      console.log(`[test-stack] ⚠️  发现 "declares no dsh.bundle" 警告`)
    }

    return { hasPlugin: pluginLoaded, bundleWarning }
  }
  die(`harness 60 秒内没就绪，日志：${HARNESS_LOG}`)
}

async function down() {
  await stopProcess(HARNESS_PID, `--port ${HARNESS_PORT}`, 'harness')
}

async function status() {
  const harness = readPid(HARNESS_PID)
  const serving = await portBusy(HARNESS_PORT)
  const logContent = existsSync(HARNESS_LOG) ? readFileSync(HARNESS_LOG, 'utf8') : ''
  console.log(JSON.stringify({
    testHome: TEST_HOME,
    homeExists: existsSync(TEST_HOME),
    harnessPid: harness,
    harnessServing: serving,
    pageUrl: PAGE_URL,
    hasBundleWarning: logContent.includes('declares no dsh.bundle'),
  }, null, 2))
}

async function up() {
  if (HARNESS_PORT === RESERVED_PORT) die('测试栈的端口不能是日常那个 harness 的端口')
  mkdirSync(STATE_DIR, { recursive: true })
  syncHome()
  relinkPlugin()
  cleanBrokenLinks()
  fixManifest()
  const result = await startHarness()

  console.log('\n' + '='.repeat(60))
  console.log('测试栈就绪。验证结果：')
  console.log(`  插件在名册中: ${result.hasPlugin ? '✅' : '❌'}`)
  console.log(`  dsh.bundle 警告: ${result.bundleWarning ? '❌ 有警告' : '✅ 无警告'}`)
  console.log(`  harness URL: ${PAGE_URL}`)
  console.log(`  harness 日志: ${HARNESS_LOG}`)
  console.log('='.repeat(60))
  console.log(`\n停掉测试栈：PATH=$HOME/.dsh/desktop-bin/node-shim:$PATH node scripts/test-stack.mjs down`)
}

const command = process.argv[2] ?? 'up'
if (command === 'up') await up()
else if (command === 'down') await down()
else if (command === 'status') await status()
else die(`未知命令 ${command}（up | down | status）`)
