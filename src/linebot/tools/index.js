// src/linebot/tools/index.js — The chatbot's tool registry.
//
// Each tool module exports { name, description, parameters, handler(args, ctx) }.
// This file aggregates them into:
//   - DECLARATIONS : the Gemini `tools` payload (functionDeclarations[]), sent on
//                    every chatTurn so the model can decide which tool to call.
//   - dispatch()   : runs one tool by name, returns its result object (error-caught).
//
// A tool's result object may carry a private `_push` array (Line messages, e.g. a
// Flex confirmation). The agent loop in chatAgent.service.js strips `_push` out
// before forwarding the result to Gemini (the model never needs it) and pushes
// those messages to the user after the text reply.

import { logger } from '../../logger.js'

import * as searchRooms         from './searchRooms.js'
import * as getRoomDetails      from './getRoomDetails.js'
import * as getFaqAnswer        from './getFaqAnswer.js'
import * as scheduleViewing     from './scheduleViewing.js'
import * as createRoomDraft     from './createRoomDraft.js'
import * as editRoomDescription from './editRoomDescription.js'
import * as escalateToAdmin     from './escalateToAdmin.js'

export const TOOLS = [
  searchRooms,
  getRoomDetails,
  getFaqAnswer,
  scheduleViewing,
  createRoomDraft,
  editRoomDescription,
  escalateToAdmin,
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)

/**
 * Gemini `tools` payload. The model sees name + description + parameters and
 * chooses whether/which to call. mode AUTO (set in the loop) lets it also reply
 * directly for chitchat without forcing a tool.
 */
export const DECLARATIONS = [{
  functionDeclarations: TOOLS.map((t) => ({
    name:        t.name,
    description: t.description,
    parameters:  t.parameters ?? { type: 'object', properties: {} },
  })),
}]

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

/**
 * Run one tool by name. Returns the handler's result object (always an object,
 * always error-caught so the loop never throws on a tool failure). The result
 * MAY include a `_push` array — the caller is responsible for extracting it.
 *
 * @param {string} name
 * @param {object} args
 * @param {{lineUserId:string, logger:object}} ctx
 * @returns {Promise<object>}
 */
export async function dispatch(name, args, ctx) {
  const tool = BY_NAME.get(name)
  if (!tool) {
    logger.warn({ name }, 'tools.dispatch: unknown tool')
    return { error: `unknown tool: ${name}` }
  }
  const started = Date.now()
  try {
    const result = await tool.handler(args ?? {}, ctx)
    logger.debug({ tool: name, ms: Date.now() - started }, 'tool ok')
    return result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : { value: result }
  } catch (err) {
    logger.error({ err, tool: name, ms: Date.now() - started }, 'tool handler threw')
    return { error: err?.message || 'tool failed' }
  }
}
