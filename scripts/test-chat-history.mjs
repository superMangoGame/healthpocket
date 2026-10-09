import assert from 'node:assert/strict'
import { createSessionHistoryAdapter } from '../web/lib/chat-history.ts'

const values = new Map()
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => { values.set(key, value) },
}
const format = {
  format: 'ai-sdk/v6',
  getId: (message) => message.id,
  encode: ({ message }) => ({ role: message.role, parts: message.parts }),
  decode: ({ id, parent_id, content }) => ({ parentId: parent_id, message: { id, ...content } }),
}

const first = createSessionHistoryAdapter('profile-1', storage).withFormat(format)
assert.ok(first)
await first.append({ parentId: null, message: { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '问题' }] } })
await first.append({ parentId: 'user-1', message: { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: '回答' }] } })

const reloaded = createSessionHistoryAdapter('profile-1', storage).withFormat(format)
assert.ok(reloaded)
assert.deepEqual(await reloaded.load(), {
  headId: 'assistant-1',
  messages: [
    { parentId: null, message: { id: 'user-1', role: 'user', parts: [{ type: 'text', text: '问题' }] } },
    { parentId: 'user-1', message: { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: '回答' }] } },
  ],
})
assert.deepEqual((await createSessionHistoryAdapter('profile-2', storage).withFormat(format).load()).messages, [])
console.log('Chat history survives reload and remains isolated by profile.')
