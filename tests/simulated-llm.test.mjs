import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  matchRule,
  parseSimulatedLlmSpec,
  providerSettings,
  startSimulatedLlm,
} from '../scripts/lib/simulated-llm.mjs'

describe('parseSimulatedLlmSpec', () => {
  it('false/空 → null', () => {
    assert.equal(parseSimulatedLlmSpec('false'), null)
    assert.equal(parseSimulatedLlmSpec(''), null)
    assert.equal(parseSimulatedLlmSpec(undefined), null)
  })
  it('true/all → 全部协议', () => {
    assert.deepEqual(parseSimulatedLlmSpec('true'), ['openai-completions', 'openai-responses', 'anthropic-messages'])
    assert.deepEqual(parseSimulatedLlmSpec('all'), ['openai-completions', 'openai-responses', 'anthropic-messages'])
  })
  it('空格分隔多值去重', () => {
    assert.deepEqual(parseSimulatedLlmSpec('openai-completions openai-responses'),
      ['openai-completions', 'openai-responses'])
    assert.deepEqual(parseSimulatedLlmSpec('openai-completions openai-completions'), ['openai-completions'])
  })
  it('未知协议报错', () => {
    assert.throws(() => parseSimulatedLlmSpec('gemini'))
  })
})

describe('matchRule', () => {
  it('工具结果 → 收尾文本', () => {
    const outcome = matchRule({ hasToolResult: true, hasTools: true, toolCalled: true, imageCount: 0, lastUserText: 'x' })
    assert.equal(outcome.kind, 'text')
    assert.equal(outcome.rule, 'tool-result')
  })
  it('声明工具且未调用 → 工具调用', () => {
    const outcome = matchRule({ hasToolResult: false, hasTools: true, toolCalled: false, imageCount: 0, lastUserText: '列出文件' })
    assert.equal(outcome.kind, 'tool-call')
    assert.equal(outcome.toolName, 'simulated_echo')
    assert.deepEqual(outcome.toolArgs, { echo: '列出文件' })
  })
  it('含图片 → 图片确认', () => {
    const outcome = matchRule({ hasToolResult: false, hasTools: false, toolCalled: false, imageCount: 2, lastUserText: '看图' })
    assert.equal(outcome.kind, 'text')
    assert.match(outcome.text, /2 张图片/u)
  })
  it('纯文本 → 回显', () => {
    const outcome = matchRule({ hasToolResult: false, hasTools: false, toolCalled: false, imageCount: 0, lastUserText: '你好' })
    assert.match(outcome.text, /模拟回复：你好/u)
  })
})

describe('providerSettings', () => {
  it('为每个协议生成 provider 路由', () => {
    const providers = providerSettings(['openai-completions', 'anthropic-messages'], 'http://127.0.0.1:9999/v1')
    assert.equal(providers['sim-openai-completions'].api, 'openai-completions')
    assert.equal(providers['sim-openai-completions'].baseURL, 'http://127.0.0.1:9999/v1')
    assert.equal(providers['sim-anthropic-messages'].models[0].id, 'test-model')
  })
})

describe('startSimulatedLlm（HTTP 集成）', () => {
  const logs = []
  let server
  const boot = async () => {
    server = await startSimulatedLlm({
      protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
      log: line => logs.push(line),
    })
    return server
  }
  after(async () => { if (server !== undefined) await server.close() })

  const post = async (path, body) => {
    const response = await fetch(`${server.baseURL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response
  }

  it('GET /v1/models 列出模型', async () => {
    await boot()
    const response = await fetch(`${server.baseURL}/models`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data[0].id, 'test-model')
  })

  it('openai-completions 非流式纯文本', async () => {
    const response = await post('/chat/completions', {
      model: 'test-model',
      messages: [{ role: 'user', content: '你好' }],
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.match(body.choices[0].message.content, /模拟回复：你好/u)
    assert.equal(body.choices[0].finish_reason, 'stop')
  })

  it('openai-completions 流式 + 工具调用', async () => {
    const response = await post('/chat/completions', {
      model: 'test-model',
      stream: true,
      tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
      messages: [{ role: 'user', content: '调用工具' }],
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/u)
    const text = await response.text()
    assert.match(text, /simulated_echo/u)
    assert.match(text, /data: \[DONE\]/u)
  })

  it('openai-completions 图片输入', async () => {
    const response = await post('/chat/completions', {
      model: 'test-model',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] }],
    })
    const body = await response.json()
    assert.match(body.choices[0].message.content, /1 张图片/u)
  })

  it('openai-responses 非流式 + 工具结果收尾', async () => {
    const response = await post('/responses', {
      model: 'test-model',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '查一下' }] },
        { type: 'function_call_output', call_id: 'call_1', output: '结果' },
      ],
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.output[0].type, 'message')
    assert.match(body.output[0].content[0].text, /工具结果已收到/u)
  })

  it('openai-responses 流式事件序列', async () => {
    const response = await post('/responses', {
      model: 'test-model',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '流式' }] }],
    })
    const text = await response.text()
    assert.match(text, /event: response\.created/u)
    assert.match(text, /response\.output_text\.delta/u)
    assert.match(text, /event: response\.completed/u)
  })

  it('anthropic-messages 非流式工具调用', async () => {
    const response = await post('/messages', {
      model: 'test-model',
      max_tokens: 1024,
      tools: [{ name: 'x', input_schema: {} }],
      messages: [{ role: 'user', content: '用工具' }],
    })
    const body = await response.json()
    assert.equal(body.content[0].type, 'tool_use')
    assert.equal(body.content[0].name, 'simulated_echo')
    assert.equal(body.stop_reason, 'tool_use')
  })

  it('anthropic-messages 流式文本', async () => {
    const response = await post('/messages', {
      model: 'test-model',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: '你好' }],
    })
    const text = await response.text()
    assert.match(text, /event: message_start/u)
    assert.match(text, /text_delta/u)
    assert.match(text, /event: message_stop/u)
  })

  it('anthropic-messages 图片 + tool_result', async () => {
    const withImage = await post('/messages', {
      model: 'test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: '看图' },
      ] }],
    })
    const imageBody = await withImage.json()
    assert.match(imageBody.content[0].text, /1 张图片/u)

    const withResult = await post('/messages', {
      model: 'test-model',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] }],
    })
    const resultBody = await withResult.json()
    assert.match(resultBody.content[0].text, /工具结果已收到/u)
  })

  it('未启用协议 → 404', async () => {
    await server.close()
    server = await startSimulatedLlm({ protocols: ['openai-completions'], log: () => {} })
    const response = await post('/messages', { model: 'test-model', messages: [] })
    assert.equal(response.status, 404)
  })

  it('请求均写入日志', () => {
    assert.ok(logs.some(line => line.includes('/v1/chat/completions')))
  })
})
