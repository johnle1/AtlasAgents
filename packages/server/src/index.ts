#!/usr/bin/env node

/**
 * =============================================================================
 * LoopyCode server — RSocket TCP entry
 * =============================================================================
 */

import * as crypto from 'node:crypto'
import * as readline from 'node:readline'

import {
  RSocketServer as RSocketServerCore,
  type Closeable,
  type Cancellable,
  type OnExtensionSubscriber,
  type OnNextSubscriber,
  type OnTerminalSubscriber,
  type Payload,
  type Requestable,
  type RSocket,
  type SetupPayload,
} from '@rsocket/core'
import { TcpServerTransport } from '@rsocket/tcp-server'

import { AuthMiddleware } from './auth/middleware.js'
import { Router, type TaskRequest } from './routing/router.js'

const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags'

type RequestResponseResponder = OnTerminalSubscriber &
  OnNextSubscriber &
  OnExtensionSubscriber

type RequestStreamSink = OnTerminalSubscriber &
  OnNextSubscriber &
  OnExtensionSubscriber

type SessionRecord = { abortControllers: Set<AbortController> }

/**
 * <Summary>
 * What it does:
 *   Builds a JSON Buffer matching the client CommandResponseEnvelope contract.
 *
 * Parameters:
 *   @param {boolean} ok — Whether the command succeeded.
 *   @param {unknown} [data] — Optional success payload.
 *   @param {string} [error] — Optional error message when ok is false.
 *
 * Returns:
 *   @returns {Buffer} — UTF-8 JSON bytes for one PAYLOAD frame.
 *
 * Dependencies:
 *   - Buffer.from — serialises JSON.
 *
 * Dependants:
 *   - RSocketServer.handleRequestResponse — success and failure paths.
 * </Summary>
 */
const commandResponseBuffer = (
  ok: boolean,
  data?: unknown,
  error?: string,
): Buffer => {
  if (ok) {
    return Buffer.from(JSON.stringify({ ok: true, data }), 'utf-8')
  }
  return Buffer.from(
    JSON.stringify({ ok: false, error: error ?? 'Command failed' }),
    'utf-8',
  )
}

/**
 * <Summary>
 * What it does:
 *   Reads the password from UTF-8 JSON metadata `{ "password": "..." }`.
 *
 * Parameters:
 *   @param {Buffer | null | undefined} metadata — RSocket frame metadata bytes.
 *
 * Returns:
 *   @returns {string} — Raw password string from metadata, possibly empty.
 *
 * Dependencies:
 *   - JSON.parse — decodes metadata JSON.
 *
 * Dependants:
 *   - RSocketServer.handleRequestResponse, handleRequestStream.
 * </Summary>
 */
const parsePasswordFromMetadata = (
  metadata: Buffer | null | undefined,
): string => {
  if (!metadata || metadata.length === 0) {
    return ''
  }
  try {
    const parsed = JSON.parse(metadata.toString('utf-8')) as {
      password?: unknown
    }
    return typeof parsed.password === 'string' ? parsed.password : ''
  } catch {
    return ''
  }
}

/**
 * <Summary>
 * What it does:
 *   Prompts for the server password with masked echo when stdin is a TTY.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<string>} — Password (may be empty for dev mode).
 *
 * Dependencies:
 *   - process.stdin, process.stdout — TTY raw read or line fallback.
 *
 * Dependants:
 *   - runServerStartupPrompts — first startup question.
 * </Summary>
 */
const readPasswordAtStartup = (): Promise<string> => {
  const stdout = process.stdout
  const stdin = process.stdin
  stdout.write('Enter server password: ')
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: stdin, output: stdout })
      rl.question('', (line) => {
        rl.close()
        resolve(line.trimEnd())
      })
    })
  }
  return new Promise((resolve) => {
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let pwd = ''
    const onData = (chunk: string | Buffer) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const ch of s) {
        const code = ch.charCodeAt(0)
        if (ch === '\n' || ch === '\r' || code === 4) {
          stdin.removeListener('data', onData)
          stdin.setRawMode(false)
          stdin.pause()
          stdout.write('\n')
          resolve(pwd)
          return
        }
        if (code === 127 || ch === '\b') {
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1)
            stdout.write('\b \b')
          }
          continue
        }
        pwd += ch
        stdout.write('•')
      }
    }
    stdin.on('data', onData)
  })
}

/**
 * <Summary>
 * What it does:
 *   Prompts for TCP listen port with default 7000 when input is empty or invalid.
 *
 * Parameters:
 *   @param {readline.Interface} rl — Readline for one line of input.
 *
 * Returns:
 *   @returns {Promise<number>} — Listen port in valid range.
 *
 * Dependencies:
 *   - readline.Interface.question — user input.
 *
 * Dependants:
 *   - runServerStartupPrompts — second startup question.
 * </Summary>
 */
const promptListenPort = (rl: readline.Interface): Promise<number> => {
  return new Promise((resolve) => {
    rl.question('Enter port (default 7000): ', (answer) => {
      const t = answer.trim()
      if (t.length === 0) {
        resolve(7000)
        return
      }
      const n = parseInt(t, 10)
      if (Number.isNaN(n) || n < 1 || n > 65_535) {
        resolve(7000)
        return
      }
      resolve(n)
    })
  })
}

/**
 * @async
 * <Summary>
 * What it does:
 *   Verifies the local Ollama HTTP API responds before accepting client traffic.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when Ollama returns 2xx.
 *
 * @throws {Error} — When fetch fails or status is not ok.
 *
 * Dependencies:
 *   - global fetch — Node 18+ HTTP client.
 *
 * Dependants:
 *   - main — gate before RSocket bind.
 * </Summary>
 */
const assertOllamaReachable = async (): Promise<void> => {
  const res = await fetch(OLLAMA_TAGS_URL, { method: 'GET' })
  if (!res.ok) {
    throw new Error(
      `Cannot reach Ollama at ${OLLAMA_TAGS_URL} (HTTP ${res.status})`,
    )
  }
}

/**
 * <Summary>
 * What it does:
 *   Runs password prompt, port prompt, and returns both values for server boot.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<{ password: string; port: number }>} — Startup answers.
 *
 * Dependencies:
 *   - readPasswordAtStartup, readline.createInterface, promptListenPort.
 *
 * Dependants:
 *   - main — composes AuthMiddleware and RSocketServer.
 * </Summary>
 */
const runServerStartupPrompts = async (): Promise<{
  password: string
  port: number
}> => {
  const password = await readPasswordAtStartup()
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const port = await promptListenPort(rl)
    return { password, port }
  } finally {
    rl.close()
  }
}

/**
 * <Summary>
 * What it does:
 *   Listens on a chosen TCP port, authenticates per-frame metadata password,
 *   routes commands and tasks through Router, and aborts work on disconnect.
 *
 * How it fits in the system:
 *   Server entry for all LoopyCode CLI traffic over RSocket.
 *
 * Dependencies:
 *   - RSocketServerCore, TcpServerTransport — protocol stack.
 *   - AuthMiddleware — password validation.
 *   - Router — command and task dispatch.
 *
 * Dependants:
 *   - main — constructs and starts one instance by default.
 * </Summary>
 */
class RSocketServer {
  private closeable: Closeable | null = null

  private readonly activeSessions = new Map<string, SessionRecord>()

  /**
   * @param {number} port — TCP listen port.
   * @param {AuthMiddleware} auth — Validates metadata password.
   * @param {Router} router — Stateless command/task router.
   */
  constructor(
    private readonly port: number,
    private readonly auth: AuthMiddleware,
    private readonly router: Router,
  ) {}

  /**
   * @async
   * <Summary>
   * What it does:
   *   Binds TcpServerTransport and RSocketServerCore until stop() is called.
   *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Resolves when the socket is listening.
 *
 * Dependencies:
 *   - TcpServerTransport, RSocketServerCore.bind — network stack.
 *
 * Dependants:
 *   - main — awaits on server startup.
 * </Summary>
   */
  start = async (): Promise<void> => {
    const transport = new TcpServerTransport({
      listenOptions: { host: '0.0.0.0', port: this.port },
    })
    const core = new RSocketServerCore({
      transport,
      acceptor: { accept: this.onAccept },
    })
    this.closeable = await core.bind()
  }

  /**
   * <Summary>
   * What it does:
   *   Closes the bound TCP server handle if present.
   *
 * Parameters:
 *   None.
 *
 * Returns:
 *   void — called for side effects only.
 *
 * Dependencies:
 *   - Closeable.close — shuts down the listener.
 *
 * Dependants:
 *   - None (available for graceful shutdown hooks).
 * </Summary>
   */
  stop = (): void => {
    this.closeable?.close()
    this.closeable = null
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Registers a new logical session after SETUP and returns server-side
   *   requestResponse/requestStream handlers for that TCP connection.
   *
 * How it does it (step by step):
 *   1. Allocates a random requesterId and an abort-controller set.
 *   2. Stores the session in activeSessions.
 *   3. Subscribes remotePeer.onClose to abort all controllers and delete the session.
 *   4. Returns Partial<RSocket> with requestResponse and requestStream methods.
 *
 * Parameters:
 *   @param {SetupPayload} _setup — RSocket SETUP payload (unused; auth is per-frame).
 *   @param {RSocket} remotePeer — Client-side socket abstraction for lifecycle hooks.
 *
 * Returns:
 *   @returns {Promise<Partial<RSocket>>} — Responder implementation for this peer.
 *
 * Dependencies:
 *   - crypto.randomUUID — session id entropy.
 *   - RSocket.onClose — disconnect detection.
 *
 * Dependants:
 *   - RSocketServerCore — invokes from acceptor during SETUP.
 * </Summary>
   */
  private onAccept = async (
    _setup: SetupPayload,
    remotePeer: RSocket,
  ): Promise<Partial<RSocket>> => {
    const requesterId = crypto.randomUUID()
    const record: SessionRecord = { abortControllers: new Set() }
    this.activeSessions.set(requesterId, record)

    remotePeer.onClose(() => {
      for (const ac of record.abortControllers) {
        ac.abort()
      }
      this.activeSessions.delete(requesterId)
    })

    return {
      requestResponse: (payload, responderStream) =>
        this.handleRequestResponse(requesterId, payload, responderStream),
      requestStream: (payload, initialN, responderStream) =>
        this.handleRequestStream(
          requesterId,
          record,
          payload,
          initialN,
          responderStream,
        ),
    }
  }

  /**
   * <Summary>
   * What it does:
   *   Handles one requestResponse command frame: auth, parse envelope, route.
   *
 * Parameters:
 *   @param {string} requesterId — Session key for this connection.
 *   @param {Payload} payload — Incoming RSocket payload + metadata.
 *   @param {RequestResponseResponder} responderStream — server→client sink.
 *
 * Returns:
 *   @returns {Cancellable & OnExtensionSubscriber} — RSocket cancellable handle.
 *
 * Dependencies:
 *   - parsePasswordFromMetadata, AuthMiddleware.validate — auth gate.
 *   - Router.routeCommand — domain dispatch.
 *   - commandResponseBuffer — JSON envelope encoding.
 *
 * Dependants:
 *   - Partial<RSocket>.requestResponse — wired from onAccept.
 * </Summary>
   */
  private handleRequestResponse = (
    requesterId: string,
    payload: Payload,
    responderStream: RequestResponseResponder,
  ): Cancellable & OnExtensionSubscriber => {
    void this.runRequestResponse(requesterId, payload, responderStream)
    return {
      cancel: () => {},
      onExtension: () => {},
    }
  }

  /**
   * @async
   * <Summary>
   * What it does:
   *   Async body for handleRequestResponse: validates, routes, sends one PAYLOAD.
   *
 * Parameters:
 *   @param {string} requesterId — Session id passed into Router.Session.
 *   @param {Payload} payload — Incoming frame.
 *   @param {RequestResponseResponder} stream — sink for one JSON response.
 *
 * Returns:
 *   @returns {Promise<void>} — Completes after onNext(..., true) or error path.
 *
 * Dependencies:
 *   - Router.routeCommand — throws on unknown or unwired routes.
 *
 * Dependants:
 *   - handleRequestResponse — schedules this as a microtask.
 * </Summary>
   */
  private runRequestResponse = async (
    requesterId: string,
    payload: Payload,
    stream: RequestResponseResponder,
  ): Promise<void> => {
    const incoming = parsePasswordFromMetadata(payload.metadata)
    const userId = this.auth.validate(incoming)
    if (userId === null) {
      stream.onNext(
        { data: commandResponseBuffer(false, undefined, 'Unauthorized') },
        true,
      )
      return
    }
    try {
      const raw = payload.data?.toString('utf-8') ?? '{}'
      const body = JSON.parse(raw) as {
        kind?: string
        type?: string
        payload?: unknown
      }
      if (body.kind !== 'command') {
        stream.onNext(
          {
            data: commandResponseBuffer(
              false,
              undefined,
              'Expected kind "command"',
            ),
          },
          true,
        )
        return
      }
      const session = { userId, requesterId }
      const data = await this.router.routeCommand(
        session,
        String(body.type),
        body.payload,
      )
      stream.onNext({ data: commandResponseBuffer(true, data) }, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stream.onNext({ data: commandResponseBuffer(false, undefined, message) }, true)
    }
  }

  /**
   * <Summary>
   * What it does:
   *   Handles one requestStream task: auth, parse task JSON, Router.routeTask.
   *
 * Parameters:
 *   @param {string} requesterId — Session id for Router.Session.
 *   @param {SessionRecord} record — Mutable set of in-flight AbortControllers.
 *   @param {Payload} payload — Initial request payload + metadata.
 *   @param {number} _initialN — Initial request-n (handled by core for credit).
 *   @param {RequestStreamSink} responderStream — token stream sink.
 *
 * Returns:
 *   @returns {Requestable & Cancellable & OnExtensionSubscriber} — RSocket stream handle.
 *
 * Dependencies:
 *   - AbortController — propagates disconnect/cancel to routeTask.
 *   - Router.routeTask — streams advisor/agent tokens.
 *
 * Dependants:
 *   - Partial<RSocket>.requestStream — wired from onAccept.
 * </Summary>
   */
  private handleRequestStream = (
    requesterId: string,
    record: SessionRecord,
    payload: Payload,
    _initialN: number,
    responderStream: RequestStreamSink,
  ): Requestable & Cancellable & OnExtensionSubscriber => {
    const incoming = parsePasswordFromMetadata(payload.metadata)
    const userId = this.auth.validate(incoming)
    if (userId === null) {
      responderStream.onError(new Error('Unauthorized'))
      return {
        request: () => {},
        cancel: () => {},
        onExtension: () => {},
      }
    }

    let parsed: {
      kind?: string
      text?: string
      advisorModel?: string
      agentModel?: string
      advisorTemp?: number
      agentTemp?: number
    }
    try {
      parsed = JSON.parse(payload.data?.toString('utf-8') ?? '{}') as typeof parsed
    } catch {
      responderStream.onError(new Error('Invalid task JSON'))
      return {
        request: () => {},
        cancel: () => {},
        onExtension: () => {},
      }
    }

    if (parsed.kind !== 'task') {
      responderStream.onError(new Error('Expected kind "task"'))
      return {
        request: () => {},
        cancel: () => {},
        onExtension: () => {},
      }
    }

    const ac = new AbortController()
    record.abortControllers.add(ac)

    const session = { userId, requesterId }
    const req: TaskRequest = {
      text: String(parsed.text ?? ''),
      advisorModel: String(parsed.advisorModel ?? ''),
      agentModel: String(parsed.agentModel ?? ''),
      advisorTemp: Number(parsed.advisorTemp ?? 0),
      agentTemp: Number(parsed.agentTemp ?? 0),
    }

    void (async () => {
      try {
        await this.router.routeTask(
          session,
          req,
          (chunk) => {
            responderStream.onNext({ data: Buffer.from(chunk, 'utf-8') }, false)
          },
          ac.signal,
        )
        responderStream.onComplete()
      } catch (err) {
        responderStream.onError(
          err instanceof Error ? err : new Error(String(err)),
        )
      } finally {
        record.abortControllers.delete(ac)
      }
    })()

    return {
      request: () => {},
      cancel: () => {
        ac.abort()
      },
      onExtension: () => {},
    }
  }
}

/**
 * @async
 * <Summary>
 * What it does:
 *   Entry point: optional help, else interactive startup prompts, Ollama check,
 *   then RSocket server bind.
 *
 * Parameters:
 *   None.
 *
 * Returns:
 *   @returns {Promise<void>} — Runs until SIGINT or process exit.
 *
 * Dependencies:
 *   - runServerStartupPrompts, assertOllamaReachable, AuthMiddleware, Router, RSocketServer.
 *
 * Dependants:
 *   - Node bootstrap — invoked at process startup.
 * </Summary>
 */
const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)

  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(`Usage:
  loopy-server [start]     Interactive startup, then listen for RSocket clients`)
    return
  }

  if (argv[0] !== undefined && argv[0] !== '' && argv[0] !== 'start') {
    console.error(`Unknown command: ${argv[0]}. Try: loopy-server help`)
    process.exit(1)
  }

  const { password, port } = await runServerStartupPrompts()

  process.stdout.write(`Connecting to Ollama at ${OLLAMA_TAGS_URL}...`)
  try {
    await assertOllamaReachable()
  } catch (err) {
    process.stdout.write('\n')
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
  console.log(' ✓')

  const auth = new AuthMiddleware(password)
  const router = new Router({})
  const server = new RSocketServer(port, auth, router)
  await server.start()
  console.log(`Server started on port ${port}`)
  console.log('Waiting for connections...')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
