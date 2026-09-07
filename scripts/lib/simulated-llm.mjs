/**
 * simulated-llm — 固定输入匹配固定输出的模拟 LLM 服务。
 *
 * 用零依赖的 node:http 实现三种协议端点：
 *   - openai-completions:  POST /v1/chat/completions（含 SSE 流式）
 *   - openai-responses:    POST /v1/responses（含 SSE 流式）
 *   - anthropic-messages:  POST /v1/messages（含 SSE 流式）
 *   - 公共:                GET  /v1/models
 *
 * 匹配规则（按优先级，确定性命中，覆盖纯文本 / 图片 / 工具调用完整 I/O）：
 *   1. 请求含工具结果        → 固定收尾文本；
 *   2. 声明了工具且本轮未调用 → 产生一次固定工具调用 simulated_echo；
 *   3. 请求含图片            → 固定文本“已收到 N 张图片”；
 *   4. 其余纯文本            → 固定应答（回显最后一条用户消息摘要）。
 */

import { createServer } from 'node:http'

/** 支持的全部协议。 */
export const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** 每个协议路由下暴露的模型 id。 */
export const SIM_MODEL = 'test-model'

/** 模拟凭据环境变量名（DSH 启动环境注入，settings.yaml 的 apiKeyEnv 引用它）。 */
export const SIM_API_KEY_ENV = 'DSH_SIM_LLM_API_KEY'

/**
 * 解析 simulated-llm 输入。
 * @param {string} input - 'true' | 'all' | 'false' | 空格分隔的协议列表
 * @returns {string[] | null} 协议数组；false/空 → null
 */
export function parseSimulatedLlmSpec(input) {
  const raw = String(input ?? '').trim()
  if (raw === '' || raw === 'false') return null
  if (raw === 'true' || raw === 'all') return [...PROTOCOLS]
  const list = raw.split(/\s+/u).filter(Boolean)
  for (const item of list) {
    if (!PROTOCOLS.includes(item)) {
      throw new Error(`simulated-llm: 未知协议 "${item}"，可选 ${PROTOCOLS.join(' / ')} / all / false`)
    }
  }
  return [...new Set(list)]
}

/** 协议 → DSH provider 路由名。 */
export function providerRouteOf(protocol) {
  return `sim-${protocol}`
}

/**
 * 生成写入 <DSH_HOME>/settings.yaml 的 llm-pi-ai providers 片段。
 * @param {string[]} protocols
 * @param {string} baseURL - 模拟服务地址（http://127.0.0.1:<port>/v1）
 */
export function providerSettings(protocols, baseURL) {
  const providers = {}
  for (const protocol of protocols) {
    providers[providerRouteOf(protocol)] = {
      displayName: `Simulated ${protocol}`,
      api: protocol,
      baseURL,
      apiKeyEnv: SIM_API_KEY_ENV,
      models: [{
        id: SIM_MODEL,
        name: 'Sim Test Model',
        contextWindow: 128000,
        maxTokens: 8192,
        input: ['text', 'image'],
      }],
    }
  }
  return providers
}

/* ------------------------------------------------------------------ */
/* 请求特征提取：三种协议归一化为同一份“请求画像”                        */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => isRecord(part) && part.type === 'text' || isRecord(part) && part.type === 'input_text')
      .map(part => part.text ?? '')
      .join('\n')
  }
  return ''
}

function countImages(content) {
  if (!Array.isArray(content)) return 0
  return content.filter(part => isRecord(part)
    && (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image')).length
}

/**
 * @returns {{ hasToolResult: boolean, hasTools: boolean, toolCalled: boolean,
 *   imageCount: number, lastUserText: string }}
 */
function analyzeOpenAICompletions(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  let hasToolResult = false
  let toolCalled = false
  let imageCount = 0
  let lastUserText = ''
  for (const msg of messages) {
    if (!isRecord(msg)) continue
    if (msg.role === 'tool') hasToolResult = true
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) toolCalled = true
    if (msg.role === 'user') {
      imageCount += countImages(msg.content)
      const text = textOfContent(msg.content)
      if (text !== '') lastUserText = text
    }
  }
  return { hasToolResult, hasTools: Array.isArray(body.tools) && body.tools.length > 0, toolCalled, imageCount, lastUserText }
}

function analyzeOpenAIResponses(body) {
  const input = Array.isArray(body.input) ? body.input : []
  let hasToolResult = false
  let toolCalled = false
  let imageCount = 0
  let lastUserText = ''
  for (const item of input) {
    if (!isRecord(item)) continue
    if (item.type === 'function_call_output') hasToolResult = true
    if (item.type === 'function_call') toolCalled = true
    if (item.type === 'message' && item.role === 'user') {
      imageCount += countImages(item.content)
      const text = textOfContent(item.content)
      if (text !== '') lastUserText = text
    }
  }
  return { hasToolResult, hasTools: Array.isArray(body.tools) && body.tools.length > 0, toolCalled, imageCount, lastUserText }
}

function analyzeAnthropicMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  let hasToolResult = false
  let toolCalled = false
  let imageCount = 0
  let lastUserText = ''
  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) {
      if (isRecord(msg) && msg.role === 'user' && typeof msg.content === 'string' && msg.content !== '') {
        lastUserText = msg.content
      }
      continue
    }
    for (const block of msg.content) {
      if (!isRecord(block)) continue
      if (msg.role === 'user' && block.type === 'tool_result') hasToolResult = true
      if (msg.role === 'assistant' && block.type === 'tool_use') toolCalled = true
      if (msg.role === 'user' && block.type === 'image') imageCount += 1
      if (msg.role === 'user' && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        lastUserText = block.text
      }
    }
  }
  return { hasToolResult, hasTools: Array.isArray(body.tools) && body.tools.length > 0, toolCalled, imageCount, lastUserText }
}

const ANALYZERS = {
  'openai-completions': analyzeOpenAICompletions,
  'openai-responses': analyzeOpenAIResponses,
  'anthropic-messages': analyzeAnthropicMessages,
}

/**
 * 固定规则匹配。
 * @returns {{ kind: 'tool-call', toolName: string, toolArgs: object }
 *   | { kind: 'text', text: string, rule: string }}
 */
export function matchRule(profile) {
  if (profile.hasToolResult) {
    return { kind: 'text', text: '工具结果已收到，任务完成。', rule: 'tool-result' }
  }
  if (profile.hasTools && !profile.toolCalled) {
    return {
      kind: 'tool-call',
      toolName: 'simulated_echo',
      toolArgs: { echo: profile.lastUserText.slice(0, 200) },
    }
  }
  if (profile.imageCount > 0) {
    return { kind: 'text', text: `已收到 ${profile.imageCount} 张图片。`, rule: 'image' }
  }
  const summary = profile.lastUserText === '' ? '(空消息)' : profile.lastUserText.slice(0, 200)
  return { kind: 'text', text: `模拟回复：${summary}`, rule: 'text' }
}

/* ------------------------------------------------------------------ */
/* 三种协议的响应构造（非流式 JSON + SSE 流式）                           */
/* ------------------------------------------------------------------ */

const USAGE = { prompt_tokens: 42, completion_tokens: 24, total_tokens: 66 }

function completionPayload(model, outcome) {
  const message = outcome.kind === 'tool-call'
    ? {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_sim_1',
          type: 'function',
          function: { name: outcome.toolName, arguments: JSON.stringify(outcome.toolArgs) },
        }],
      }
    : { role: 'assistant', content: outcome.text }
  return {
    id: 'chatcmpl-sim',
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: outcome.kind === 'tool-call' ? 'tool_calls' : 'stop',
    }],
    usage: USAGE,
  }
}

function writeSse(res, events, done = true) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const [event, data] of events) {
    if (event !== null) res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  if (done) res.write('data: [DONE]\n\n')
  res.end()
}

function respondCompletions(res, model, outcome, stream) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(completionPayload(model, outcome)))
    return
  }
  const chunkBase = { id: 'chatcmpl-sim', object: 'chat.completion.chunk', created: 1700000000, model }
  const events = []
  if (outcome.kind === 'tool-call') {
    events.push([null, { ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_sim_1', type: 'function', function: { name: outcome.toolName, arguments: '' } }] }, finish_reason: null }] }])
    events.push([null, { ...chunkBase, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(outcome.toolArgs) } }] }, finish_reason: null }] }])
    events.push([null, { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }])
  } else {
    events.push([null, { ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }])
    for (const piece of splitText(outcome.text)) {
      events.push([null, { ...chunkBase, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }])
    }
    events.push([null, { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
  }
  writeSse(res, events)
}

function splitText(text) {
  // 按小段切分以模拟流式输出
  const pieces = []
  for (let i = 0; i < text.length; i += 8) pieces.push(text.slice(i, i + 8))
  return pieces.length > 0 ? pieces : ['']
}

function responsesOutputItem(outcome) {
  if (outcome.kind === 'tool-call') {
    return {
      type: 'function_call',
      id: 'fc_sim_1',
      call_id: 'call_sim_1',
      name: outcome.toolName,
      arguments: JSON.stringify(outcome.toolArgs),
      status: 'completed',
    }
  }
  return {
    type: 'message',
    id: 'msg_sim_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: outcome.text, annotations: [] }],
  }
}

function responsesEnvelope(model, outcome) {
  const item = responsesOutputItem(outcome)
  return {
    id: 'resp_sim_1',
    object: 'response',
    created_at: 1700000000,
    status: 'completed',
    model,
    output: [item],
    usage: { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens, total_tokens: USAGE.total_tokens },
  }
}

function respondResponses(res, model, outcome, stream) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(responsesEnvelope(model, outcome)))
    return
  }
  const envelope = responsesEnvelope(model, outcome)
  const item = envelope.output[0]
  const events = [
    ['response.created', { type: 'response.created', response: { ...envelope, output: [], status: 'in_progress' } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } }],
  ]
  if (item.type === 'function_call') {
    events.push(['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments }])
    events.push(['response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments }])
  } else {
    for (const piece of splitText(outcome.text)) {
      events.push(['response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: piece }])
    }
    events.push(['response.output_text.done', { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: outcome.text }])
  }
  events.push(['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }])
  events.push(['response.completed', { type: 'response.completed', response: envelope }])
  writeSse(res, events, false)
}

function anthropicPayload(model, outcome) {
  const content = outcome.kind === 'tool-call'
    ? [{ type: 'tool_use', id: 'toolu_sim_1', name: outcome.toolName, input: outcome.toolArgs }]
    : [{ type: 'text', text: outcome.text }]
  return {
    id: 'msg_sim_1',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: outcome.kind === 'tool-call' ? 'tool_use' : 'end_turn',
    usage: { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens },
  }
}

function respondAnthropic(res, model, outcome, stream) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(anthropicPayload(model, outcome)))
    return
  }
  const payload = anthropicPayload(model, outcome)
  const block = payload.content[0]
  const events = [
    ['message_start', { type: 'message_start', message: { ...payload, content: [], stop_reason: null } }],
  ]
  if (block.type === 'tool_use') {
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }])
  } else {
    events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }])
    for (const piece of splitText(outcome.text)) {
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }])
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }])
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: payload.stop_reason }, usage: { output_tokens: USAGE.completion_tokens } }])
  events.push(['message_stop', { type: 'message_stop' }])
  writeSse(res, events, false)
}

const ROUTES = [
  { protocol: 'openai-completions', method: 'POST', path: '/v1/chat/completions', respond: respondCompletions },
  { protocol: 'openai-responses', method: 'POST', path: '/v1/responses', respond: respondResponses },
  { protocol: 'anthropic-messages', method: 'POST', path: '/v1/messages', respond: respondAnthropic },
]

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 启动模拟 LLM 服务。
 * @param {{ protocols: string[], log?: (line: string) => void }} options
 * @returns {Promise<{ port: number, baseURL: string, close: () => Promise<void> }>}
 */
export async function startSimulatedLlm({ protocols, log = () => {} }) {
  const enabled = new Set(protocols)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const data = [...enabled].map(protocol => providerRouteOf(protocol)).map(route => ({
          id: SIM_MODEL,
          object: 'model',
          created: 1700000000,
          owned_by: route,
        }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data }))
        log(`GET /v1/models → 200 (${data.length} models)`)
        return
      }
      const route = ROUTES.find(r => r.method === req.method && r.path === url.pathname)
      if (route === undefined || !enabled.has(route.protocol)) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `simulated-llm: no route for ${req.method} ${url.pathname}` } }))
        log(`${req.method} ${url.pathname} → 404`)
        return
      }
      const raw = await readBody(req)
      const body = JSON.parse(raw)
      const profile = ANALYZERS[route.protocol](body)
      const outcome = matchRule(profile)
      const model = typeof body.model === 'string' ? body.model : SIM_MODEL
      const stream = body.stream === true
      const summary = outcome.kind === 'tool-call'
        ? `tool-call ${outcome.toolName}`
        : `text[${outcome.rule}] "${outcome.text.slice(0, 60)}"`
      log(`${req.method} ${url.pathname} protocol=${route.protocol} model=${model} stream=${stream}`
        + ` tools=${profile.hasTools} toolResult=${profile.hasToolResult} images=${profile.imageCount} → ${summary}`)
      route.respond(res, model, outcome, stream)
    } catch (error) {
      log(`${req.method} ${url.pathname} → 500 ${error instanceof Error ? error.message : String(error)}`)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  log(`simulated-llm 已启动：http://127.0.0.1:${port}/v1 协议=[${[...enabled].join(', ')}]`)
  return {
    port,
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
