/* global AbortController */
import websocket from 'websocket'
import dotenv from 'dotenv'
import debug from 'debug'
import { create as createIpfs } from 'ipfs-http-client'
import PQueue from 'p-queue'
import formatNumber from 'format-number'
import { publishRecord } from './publish.js'
import { shorten } from './utils/string.js'

dotenv.config()

const CONCURRENCY = 5
const fmt = formatNumber()

const WebSocket = websocket.client
const log = debug('ipns-pub')
log.enabled = true
log.debug = debug('ipns-pub-debug')

/**
 * Listen to the websocket on the w3name service to receive updates to IPNS name records
 * and publish those updates to the DHT.
 */
async function main () {
  log('ℹ️ Enable verbose logging with DEBUG=ipns-pub-debug*')
  const endpoint = process.env.ENDPOINT || 'wss://api.web3.storage'
  const url = new URL('name/*/watch', endpoint)

  /** @type {Map<string, { record: string }>} */
  const taskData = new Map()
  /** @type {Set<string>} */
  const runningTasks = new Set()
  const queue = new PQueue({ concurrency: CONCURRENCY })

  while (true) {
    const ipfs = createIpfs()

    /** @type {import('websocket').connection} */
    const conn = await new Promise((resolve, reject) => {
      const client = new WebSocket()
      client.connect(url.toString())
      client.on('connect', resolve).on('connectFailed', reject)
    })

    log(`🔌 Websocket connected to ${url}`)

    try {
      await new Promise((resolve, reject) => {
        conn.on('message', async msg => {
          const { key, value, record: b64Record } = JSON.parse(msg.utf8Data)
          const keyLog = log.extend(shorten(key))
          keyLog.enabled = true
          keyLog(`🆕 /ipns/${key} ➡️ ${value}`)

          let data = taskData.get(key)
          if (data) {
            Object.assign(data, { value, record: b64Record })
            return keyLog('👌 Already in the queue (record to publish has been updated)')
          }

          data = { value, record: b64Record }
          taskData.set(key, data)

          const start = Date.now()
          keyLog(`➕ Adding to the queue, position: ${fmt(queue.size)}`)
          queue.add(async function run () {
            // if this task is already running, lets not concurrently put
            // multiple versions for the same key!
            if (runningTasks.has(key)) {
              keyLog('🏃 Already running! Re-queue in 60s...')
              await sleep(60_000)
              if (taskData.has(key) && taskData.get(key) !== data) {
                return keyLog('⏩ Skipping re-queue, a newer update has been queued already.')
              }
              taskData.set(key, data)
              keyLog(`➕ Re-adding to the queue, position: ${fmt(queue.size)}`)
              queue.add(run)
              return
            }
            keyLog(`🏁 Starting publish (was queued for ${fmt(Date.now() - start)}ms)`)
            runningTasks.add(key)

            try {
              const data = taskData.get(key)
              if (!data) throw new Error('missing task data')
              taskData.delete(key)
              publishRecord(ipfs, key, data.value, data.record)
            } finally {
              runningTasks.delete(key)
            }
          })
        })

        conn.on('error', err => reject(err))

        conn.on('close', (code, desc) => {
          reject(Object.assign(new Error(`websocket connection closed: ${desc}`), { code }))
        })
      })
    } catch (err) {
      log(err)
    }

    log('💤 Sleeping before retry')
    await sleep(60_000)
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

main()
