/**
 * pi-subagents-lean —— 延迟暴露（deferred）的子代理工具组。
 *
 * 设计约束（用户要求）：
 * - 默认零占用：所有工具用 `exposure: 'deferred'` 注册，不进系统提示、不进工具列表；
 *   只有模型（或人）用 `tool_search` 搜到它们之后，下一个请求才会带上声明。
 * - 一个常驻发现提示（约 50 token）说明存在这一组工具。
 * - 能力对齐常见子代理插件：markdown 定义代理、task/background 两种模式、状态 / 结果 /
 *   历史 / 取消、per-agent 的 model 与 effort 覆盖、可选的续跑（enable_continue）。
 *
 * 子代理就是另一个 `pi -p` 进程：独立 cwd、独立工具集、独立会话目录；代理 markdown 的正文
 * 通过 `--append-system-prompt` 注入，任务作为用户消息。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.pi', 'agent')
const STATE_DIR = join(AGENT_DIR, 'subagents')
const SESSION_DIR = join(STATE_DIR, 'sessions')
const MAX_CAPTURE = Number(process.env.PI_SUBAGENT_MAX_CAPTURE ?? 48 * 1024)
const MAX_DEPTH = Number(process.env.PI_SUBAGENT_MAX_DEPTH ?? 2)
const DEFAULT_TOOLS = 'read,bash,edit,write'
const HINT = 'Delegate work with `tool_search`: it finds the subagent tools (subagent_run, subagent_status, subagent_result, subagent_list_agents, subagent_list_tasks, subagent_cancel). Use them for units that do not depend on each other, never for work that needs this conversation.'

/** 读取 JSON 文件；缺失或损坏时返回 undefined。 */
function readJson (file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 原子写 JSON：先写临时文件再替换，避免读到半个文件。 */
function writeJson (file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, file)
}

/** 解析 markdown 的 `---` frontmatter；没有就用空对象。 */
function parseFrontmatter (text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text)
  if (match === null) return { data: {}, body: text.trim() }
  const data = {}
  for (const line of match[1].split(/\r?\n/u)) {
    const pair = /^(\w[\w.-]*)\s*:\s*([^#]*?)(?:\s+#.*)?$/u.exec(line.trim())
    if (pair !== null) data[pair[1]] = pair[2].trim().replace(/^"(.*)"$/u, '$1').replace(/^'(.*)'$/u, '$1')
  }
  return { data, body: match[2].trim() }
}

/** 把逗号/空白分隔的字符串或数组规整成去重的工具名列表。 */
function toolList (value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '')
  const names = raw.split(/[,;\s]+/u).map((name) => name.trim()).filter((name) => name !== '')
  return [...new Set(names)]
}

/** 合并全局与项目配置，后者优先。 */
function readConfig (cwd) {
  const global = readJson(join(AGENT_DIR, 'subagents.json')) ?? {}
  const project = readJson(join(cwd, '.pi', 'subagents.json')) ?? {}
  const merged = { ...global, ...project }
  return {
    defaultAgent: String(merged.default_agent ?? 'general'),
    defaultModel: typeof merged.default_model === 'string' ? merged.default_model : undefined,
    defaultEffort: typeof merged.default_effort === 'string' ? merged.default_effort : undefined,
    defaultTools: merged.default_tools === undefined ? DEFAULT_TOOLS : toolList(merged.default_tools).join(','),
    timeoutMs: Number.isFinite(Number(merged.timeout_ms)) ? Math.max(1, Number(merged.timeout_ms)) : 900_000,
    maxConcurrency: Number.isFinite(Number(merged.max_concurrency)) ? Math.max(1, Number(merged.max_concurrency)) : 4,
    enableContinue: merged.enable_continue === true,
    agentsDirs: Array.isArray(merged.agents_dirs) ? merged.agents_dirs.map(String) : [],
  }
}

/** 一个目录里的所有代理定义。损坏的文件被列出但不参与运行。 */
function loadAgentsFrom (dir, scope) {
  if (!existsSync(dir)) return []
  const agents = []
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
    const path = join(dir, file)
    const name = file.slice(0, -'.md'.length).trim().toLowerCase()
    const problems = []
    let parsed
    try {
      parsed = parseFrontmatter(readFileSync(path, 'utf8'))
    } catch (error) {
      agents.push({ name, scope, path, problems: [`cannot read: ${String(error)}`] })
      continue
    }
    const declared = typeof parsed.data.name === 'string' ? parsed.data.name.trim().toLowerCase() : name
    if (declared !== name) problems.push(`name "${declared}" must match the file name "${name}"`)
    if (parsed.body === '') problems.push('body is empty, so the agent has no system prompt')
    agents.push({
      name,
      scope,
      path,
      description: typeof parsed.data.description === 'string' ? parsed.data.description : `${name} subagent`,
      body: parsed.body,
      tools: toolList(parsed.data.tools),
      model: typeof parsed.data.model === 'string' ? parsed.data.model : undefined,
      effort: typeof parsed.data.effort === 'string' ? parsed.data.effort : typeof parsed.data.thinking === 'string' ? parsed.data.thinking : undefined,
      problems,
    })
  }
  return agents
}

/** 全局、项目、配置目录三处的代理定义；同名时项目覆盖全局。 */
function loadAgents (cwd, config, trusted) {
  const global = loadAgentsFrom(join(AGENT_DIR, 'agents'), 'global')
  const projectDefault = trusted ? loadAgentsFrom(join(cwd, '.pi', 'agents'), 'project') : []
  const extra = config.agentsDirs.flatMap((dir) => {
    const path = resolve(cwd, dir)
    return trusted || path.startsWith(resolve(AGENT_DIR)) ? loadAgentsFrom(path, 'config') : []
  })
  const merged = new Map()
  for (const agent of global) merged.set(agent.name, agent)
  for (const agent of extra) merged.set(agent.name, agent)
  for (const agent of projectDefault) merged.set(agent.name, agent)
  // 内置 general 让 subagent_run 在没有任何 markdown 定义时也能用。
  if (!merged.has('general')) {
    merged.set('general', {
      name: 'general',
      scope: 'builtin',
      path: '(builtin)',
      description: 'General-purpose subagent for one self-contained unit of work.',
      body: 'You are a subagent. Complete the single unit of work in the task message, verify it with the tools you have, and reply with what you did, what you verified and anything left undone. Do not ask the caller questions; state the assumption you took.',
      tools: [],
      model: undefined,
      effort: undefined,
      problems: [],
    })
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/** 子代理进程的入口：优先复用当前 CLI 脚本，其次退回 PATH 上的 pi。 */
function resolveCommand () {
  const override = process.env.PI_SUBAGENT_CLI
  if (override !== undefined && override !== '' && existsSync(override)) return { file: override, prefix: [] }
  const entry = process.argv[1]
  if (entry !== undefined && entry !== '' && existsSync(entry) && /\.[cm]?js$/u.test(entry)) {
    return { file: process.execPath, prefix: [entry] }
  }
  return { file: 'pi', prefix: [], shell: true }
}

/** 子进程环境：去掉父会话标识，记录嵌套深度。 */
function childEnv (depth) {
  const env = { ...process.env }
  delete env.PI_SESSION_ID
  delete env.PI_SESSION_FILE
  env.PI_SUBAGENT_DEPTH = String(depth)
  return env
}

/** 裁到上限，保留尾部。 */
function cap (text) {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_CAPTURE) return trimmed
  return `…(${trimmed.length - MAX_CAPTURE} chars omitted)…\n${trimmed.slice(-MAX_CAPTURE)}`
}

/** 结束整棵进程树。 */
function killTree (child) {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** 一次任务的状态文件路径。 */
function statePath (id) { return join(STATE_DIR, `${id}.json`) }
/** 一次任务的输出文件路径。 */
function logPath (id) { return join(STATE_DIR, `${id}.log`) }

/** 读取一次任务的状态。 */
function readTask (id) { return readJson(statePath(id)) }

/** 最近的任务，按开始时间倒序。 */
function recentTasks (limit) {
  if (!existsSync(STATE_DIR)) return []
  const ids = readdirSync(STATE_DIR).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
  const tasks = ids.map(readTask).filter((task) => task !== undefined)
  return tasks.sort((left, right) => right.startedAt - left.startedAt).slice(0, limit)
}

/** 任务 id：短、可读、不含平台保留字符。 */
function newTaskId () {
  const stamp = new Date().toISOString().replace(/[-:T.]/gu, '').slice(0, 14)
  return `sa-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

/** 把状态渲染成一行。 */
function describeTask (task) {
  const seconds = ((task.endedAt ?? Date.now()) - task.startedAt) / 1000
  const status = task.endedAt === undefined ? (task.cancelled === true ? 'cancelled' : 'running') : `exit ${task.exitCode}`
  return `${task.id} [${status}] ${seconds.toFixed(0)}s agent=${task.agent} mode=${task.mode} — ${task.task.slice(0, 120)}`
}

/** 睡眠，用于 subagent_result 的等待。 */
function sleep (ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export function apply (pi) {
  /** 进程内正在运行的任务；跨进程只靠状态文件。 */
  const running = new Map()

  // 常驻的发现提示：只说明“有这组工具、用 tool_search 找”，不含任何声明。
  pi.on('before_agent_start', async (event) => {
    const options = event.systemPromptOptions
    if (options?.sections === undefined) return undefined
    options.sections['pi-subagents-hint'] = HINT
    return undefined
  })

  const config = (ctx) => readConfig(ctx.cwd)

  pi.registerTool({
    name: 'subagent_run',
    label: 'Run subagent',
    description:
      'Delegate one self-contained unit of work to a subagent. mode "background" (default) returns a task id immediately and wakes this session with the result when the child exits; mode "task" waits and returns the child answer. The child is a separate pi run with its own context, working directory and tool set.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The work order: files to touch, expected output, acceptance check.' },
        agent: { type: 'string', description: 'Markdown-defined agent name. Default from subagents.json, else "general".' },
        cwd: { type: 'string', description: 'Working directory for the child. Defaults to the current directory.' },
        mode: { type: 'string', description: '"background" (default) or "task".' },
        model: { type: 'string', description: 'Model override, for example provider/id.' },
        effort: { type: 'string', description: 'Thinking level override: off, minimal, low, medium, high, xhigh, max.' },
        tools: { type: 'string', description: `Comma-separated tool names for the child. Default ${DEFAULT_TOOLS} or the agent definition.` },
        timeout_ms: { type: 'number', description: 'Kill the child after this many milliseconds.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    exposure: 'deferred',
    async execute (toolCallId, params, signal, onUpdate, ctx) {
      const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? 0) || 0
      if (depth >= MAX_DEPTH) {
        return failure(`subagent_run: nesting depth ${depth} already reached the limit of ${MAX_DEPTH}; do this unit yourself.`)
      }
      const settings = config(ctx)
      const task = String(params.task ?? '').trim()
      if (task === '') return failure('subagent_run: task must not be empty')
      const runningCount = recentTasks(200).filter((task_) => task_.endedAt === undefined && task_.cancelled !== true).length
      if (runningCount >= settings.maxConcurrency) {
        return failure(`subagent_run: ${runningCount} subagents are already running (max_concurrency ${settings.maxConcurrency}); wait for one to finish or raise the limit.`)
      }
      const cwd = String(params.cwd ?? ctx.cwd)
      if (!existsSync(cwd)) return failure(`subagent_run: working directory does not exist: ${cwd}`)
      const agentName = String(params.agent ?? settings.defaultAgent)
      const agents = loadAgents(cwd, settings, ctx.isProjectTrusted())
      const agent = agents.find((candidate) => candidate.name === agentName)
      if (agent === undefined) {
        return failure(`subagent_run: unknown agent "${agentName}". Known agents: ${agents.map((candidate) => candidate.name).join(', ') || '(none)'}. Run subagent_list_agents for details.`)
      }
      if (agent.problems.length > 0) {
        return failure(`subagent_run: agent "${agent.name}" is unusable: ${agent.problems.join('; ')}`)
      }
      const model = String(params.model ?? agent.model ?? settings.defaultModel ?? (ctx.model === undefined ? '' : `${ctx.model.provider}/${ctx.model.id}`))
      const effort = String(params.effort ?? agent.effort ?? settings.defaultEffort ?? ctx.thinkingLevel ?? '')
      const tools = toolList(params.tools !== undefined ? params.tools : agent.tools.length > 0 ? agent.tools.join(',') : settings.defaultTools)
      if (tools.length === 0) return failure('subagent_run: no tools would be available to the child')

      const id = newTaskId()
      const background = String(params.mode ?? 'background') !== 'task'
      const timeoutMs = Number.isFinite(Number(params.timeout_ms)) ? Number(params.timeout_ms) : settings.timeoutMs
      mkdirSync(SESSION_DIR, { recursive: true })
      const sessionDir = join(SESSION_DIR, id)
      const agentFile = join(sessionDir, 'agent.md')
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(agentFile, agent.body)

      const command = resolveCommand()
      const args = [
        ...command.prefix,
        '-p', task,
        '--tools', tools.join(','),
        '--session-dir', sessionDir,
        '--append-system-prompt', agentFile,
      ]
      if (model !== '') args.push('--model', model)
      if (effort !== '') args.push('--thinking', effort)

      const startedAt = Date.now()
      const child = spawn(command.file, args, {
        cwd,
        env: childEnv(depth + 1),
        shell: command.shell === true,
        detached: background,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      writeFileSync(logPath(id), '')
      const state = {
        id,
        agent: agent.name,
        mode: background ? 'background' : 'task',
        task,
        cwd,
        model: model === '' ? undefined : model,
        effort: effort === '' ? undefined : effort,
        tools: tools.join(','),
        sessionDir,
        startedAt,
        pid: child.pid,
      }
      writeJson(statePath(id), state)

      let captured = ''
      const append = (chunk) => {
        captured += chunk
        if (captured.length > MAX_CAPTURE * 2) captured = captured.slice(-MAX_CAPTURE)
        try { writeFileSync(logPath(id), captured) } catch { /* capture stays in memory */ }
      }
      child.stdout?.on('data', (chunk) => append(String(chunk)))
      child.stderr?.on('data', (chunk) => append(String(chunk)))

      const timer = setTimeout(() => killTree(child), timeoutMs)
      const onAbort = () => killTree(child)
      signal?.addEventListener('abort', onAbort, { once: true })

      const settle = (exitCode) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        running.delete(id)
        const final = readTask(id) ?? state
        final.endedAt = Date.now()
        final.exitCode = exitCode
        final.seconds = ((final.endedAt - final.startedAt) / 1000).toFixed(1)
        writeJson(statePath(id), final)
        try { writeFileSync(logPath(id), captured) } catch { /* best effort */ }
        return final
      }

      if (background) {
        child.on('exit', (code) => {
          const final = settle(code ?? 0)
          const text = [
            `Subagent ${final.id} (${final.agent}) ${final.exitCode === 0 ? 'finished' : `failed with exit ${final.exitCode}`} in ${final.seconds}s.`,
            '',
            cap(captured) === '' ? '(no output)' : cap(captured),
            '',
            'Continue from this result. Do not redo the unit.',
          ].join('\n')
          try { pi.sendUserMessage(text, { deliverAs: 'followUp' }) } catch { /* session is shutting down */ }
        })
        child.on('error', (error) => {
          append(`spawn failed: ${String(error)}\n`)
          settle(-1)
        })
        running.set(id, child)
        return success(`Started ${id} (agent ${agent.name}, pid ${child.pid}) in ${cwd}. It runs in the background; you are woken with its result when it exits. Do not wait for it now — end the turn.`)
      }

      return await new Promise((resolveTask) => {
        let settled = false
        const progress = setInterval(() => {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
          try {
            onUpdate?.({ content: [{ type: 'text', text: `subagent ${id} running ${elapsed}s…\n${cap(captured).slice(-800)}` }] })
          } catch { /* UI gone */ }
        }, 15_000)
        const done = (exitCode) => {
          if (settled) return
          settled = true
          clearInterval(progress)
          const final = settle(exitCode)
          const text = [
            `Subagent ${final.id} (${final.agent}) ${final.exitCode === 0 ? 'finished' : `failed with exit ${final.exitCode}`} in ${final.seconds}s.`,
            '',
            cap(captured) === '' ? '(no output)' : cap(captured),
          ].join('\n')
          running.set(id, child)
          resolveTask(exitCode === 0 ? success(text) : failure(text))
        }
        child.on('exit', (code) => done(code ?? 0))
        child.on('error', (error) => { append(`spawn failed: ${String(error)}\n`); done(-1) })
      })
    },
  })

  pi.registerTool({
    name: 'subagent_status',
    label: 'Subagent status',
    description: 'Report one subagent task, or the most recent tasks when no id is given.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from subagent_run. Omit to list recent tasks.' },
        limit: { type: 'number', description: 'How many recent tasks to list. Default 10.' },
      },
      additionalProperties: false,
    },
    exposure: 'deferred',
    async execute (toolCallId, params) {
      if (typeof params.task_id === 'string' && params.task_id !== '') {
        const task = readTask(params.task_id)
        if (task === undefined) return failure(`subagent_status: unknown task ${params.task_id}`)
        return success([
          describeTask(task),
          `model=${task.model ?? '(session default)'} effort=${task.effort ?? '(session default)'} tools=${task.tools}`,
          `session=${task.sessionDir}`,
        ].join('\n'))
      }
      const tasks = recentTasks(Number(params.limit ?? 10))
      if (tasks.length === 0) return success('No subagent tasks yet.')
      return success(tasks.map(describeTask).join('\n'))
    },
  })

  pi.registerTool({
    name: 'subagent_result',
    label: 'Subagent result',
    description: 'Return the output of a finished subagent task; with wait_seconds it waits for a running task up to that many seconds.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task id from subagent_run.' },
        wait_seconds: { type: 'number', description: 'Wait this many seconds for the task to finish. Default 0.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    exposure: 'deferred',
    async execute (toolCallId, params) {
      const id = String(params.task_id)
      const deadline = Date.now() + Math.max(0, Number(params.wait_seconds ?? 0)) * 1000
      let task = readTask(id)
      while (task !== undefined && task.endedAt === undefined && Date.now() < deadline) {
        await sleep(500)
        task = readTask(id)
      }
      if (task === undefined) return failure(`subagent_result: unknown task ${id}`)
      const body = existsSync(logPath(id)) ? cap(readFileSync(logPath(id), 'utf8')) : ''
      if (task.endedAt === undefined) {
        return success([describeTask(task), '', body === '' ? '(still running, no output yet)' : body].join('\n'))
      }
      return success([describeTask(task), '', body === '' ? '(no output)' : body].join('\n'))
    },
  })

  pi.registerTool({
    name: 'subagent_list_agents',
    label: 'List subagents',
    description: 'List markdown-defined subagents available from the global agent dir, the project, and configured directories.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    exposure: 'deferred',
    async execute (toolCallId, params, signal, onUpdate, ctx) {
      const settings = config(ctx)
      const agents = loadAgents(ctx.cwd, settings, ctx.isProjectTrusted())
      if (agents.length === 0) {
        return success('No subagent definitions found. Add markdown files to <agent-dir>/agents or <project>/.pi/agents.')
      }
      return success(agents.map((agent) => {
        const broken = agent.problems.length > 0 ? ` UNUSABLE: ${agent.problems.join('; ')}` : ''
        return `${agent.name} (${agent.scope}) — ${agent.description}${broken}`
      }).join('\n'))
    },
  })

  pi.registerTool({
    name: 'subagent_list_tasks',
    label: 'List subagent tasks',
    description: 'List persisted subagent tasks with status, agent, mode and output preview.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent tasks to list. Default 20.' } },
      additionalProperties: false,
    },
    exposure: 'deferred',
    async execute (toolCallId, params) {
      const tasks = recentTasks(Number(params.limit ?? 20))
      if (tasks.length === 0) return success('No subagent tasks yet.')
      return success(tasks.map(describeTask).join('\n'))
    },
  })

  pi.registerTool({
    name: 'subagent_cancel',
    label: 'Cancel subagent',
    description: 'Cancel a running subagent task by killing its process tree.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id from subagent_run.' } },
      required: ['task_id'],
      additionalProperties: false,
    },
    exposure: 'deferred',
    async execute (toolCallId, params) {
      const id = String(params.task_id)
      const task = readTask(id)
      if (task === undefined) return failure(`subagent_cancel: unknown task ${id}`)
      if (task.endedAt !== undefined) return success(`subagent_cancel: ${id} already ended with exit ${task.exitCode}.`)
      const child = running.get(id)
      if (child === undefined) {
        if (task.pid === undefined) return failure(`subagent_cancel: ${id} has no pid recorded`)
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(task.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          else process.kill(-task.pid, 'SIGKILL')
        } catch (error) {
          return failure(`subagent_cancel: could not kill pid ${task.pid}: ${String(error)}`)
        }
      } else {
        killTree(child)
      }
      writeJson(statePath(id), { ...task, cancelled: true })
      return success(`Cancelled ${id}.`)
    },
  })

  /** 成功结果。 */
  function success (text) {
    return { content: [{ type: 'text', text }] }
  }
  /** 失败结果。 */
  function failure (text) {
    return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true }
  }

  // 续跑需要显式开启，因为它复用子会话并可能持续放大成本。
  const continueEnabled = () => readConfig(process.cwd()).enableContinue
  if (continueEnabled()) {
    pi.registerTool({
      name: 'subagent_continue',
      label: 'Continue subagent',
      description: 'Send a follow-up task to a finished subagent, reusing its persisted session.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Finished task id.' },
          task: { type: 'string', description: 'The follow-up instruction.' },
          effort: { type: 'string', description: 'Thinking level override.' },
        },
        required: ['task_id', 'task'],
        additionalProperties: false,
      },
      exposure: 'deferred',
      async execute (toolCallId, params, signal, onUpdate, ctx) {
        const prior = readTask(String(params.task_id))
        if (prior === undefined) return failure(`subagent_continue: unknown task ${params.task_id}`)
        if (prior.endedAt === undefined) return failure(`subagent_continue: ${prior.id} is still running; use subagent_result with wait_seconds.`)
        const followUp = String(params.task ?? '').trim()
        if (followUp === '') return failure('subagent_continue: task must not be empty')
        const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? 0) || 0
        if (depth >= MAX_DEPTH) return failure(`subagent_continue: nesting depth ${depth} reached the limit of ${MAX_DEPTH}`)
        const id = newTaskId()
        const command = resolveCommand()
        const args = [...command.prefix, '-p', followUp, '--session', prior.sessionDir, '--tools', prior.tools]
        if (typeof params.effort === 'string' && params.effort !== '') args.push('--thinking', params.effort)
        if (prior.model !== undefined) args.push('--model', prior.model)
        const startedAt = Date.now()
        const child = spawn(command.file, args, {
          cwd: prior.cwd,
          env: childEnv(depth + 1),
          shell: command.shell === true,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        writeFileSync(logPath(id), '')
        const state = { ...prior, id, task: followUp, startedAt, endedAt: undefined, exitCode: undefined, cancelled: undefined, pid: child.pid }
        writeJson(statePath(id), state)
        let captured = ''
        child.stdout?.on('data', (chunk) => { captured += String(chunk) })
        child.stderr?.on('data', (chunk) => { captured += String(chunk) })
        child.on('exit', (code) => {
          const final = readTask(id) ?? state
          final.endedAt = Date.now()
          final.exitCode = code ?? 0
          final.seconds = ((final.endedAt - final.startedAt) / 1000).toFixed(1)
          writeJson(statePath(id), final)
          writeFileSync(logPath(id), captured)
          try {
            pi.sendUserMessage([`Subagent continuation ${id} (${final.agent}) finished in ${final.seconds}s.`, '', cap(captured) === '' ? '(no output)' : cap(captured)].join('\n'), { deliverAs: 'followUp' })
          } catch { /* session is shutting down */ }
        })
        return success(`Started continuation ${id} from ${prior.id}. You are woken with its result.`)
      },
    })
  }

  pi.registerCommand?.('subagents', {
    description: 'List subagent tasks and their status',
    handler: async (args, ctx) => {
      const limit = Number(args) > 0 ? Number(args) : 10
      const tasks = recentTasks(limit)
      const text = tasks.length === 0 ? 'No subagent tasks yet.' : tasks.map(describeTask).join('\n')
      ctx?.ui?.notify?.(text, 'info')
    },
  })
}

export default apply
