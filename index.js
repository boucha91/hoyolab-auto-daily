#!/usr/bin/env node

if (!process.env.COOKIE) throw new Error('COOKIE environment variable not set!')
if (!process.env.GAMES) throw new Error('GAMES environment variable not set!')

const cookies = process.env.COOKIE.split('\n').map(s => s.trim())
const games = process.env.GAMES.split('\n').map(s => s.trim())
const discordWebhook = process.env.DISCORD_WEBHOOK
const discordUser = process.env.DISCORD_USER
const telegramToken = process.env.TELEGRAM_TOKEN
const telegramChat = process.env.TELEGRAM_CHAT_ID
// Locale sent to the check-in API, which decides the language of the reward
// messages shown in-game and in the HoYoLAB check-in history.
// `||` (not `??`) is intentional: an unset repository variable is injected as an
// empty string by Actions, and an empty `lang` would be sent to the API.
const language = process.env.HOYOLAB_LANG?.trim() || 'en-us'
const msgDelimiter = ':'
const icon = { info: '✅', error: '❌' }
const messages = []
const endpoints = {
  zzz: 'https://sg-act-nap-api.hoyolab.com/event/luna/zzz/os/sign?act_id=e202406031448091',
  gi:  'https://sg-hk4e-api.hoyolab.com/event/sol/sign?act_id=e202102251931481',
  hsr: 'https://sg-public-api.hoyolab.com/event/luna/os/sign?act_id=e202303301540311',
  hi3: 'https://sg-public-api.hoyolab.com/event/mani/sign?act_id=e202110291205111',
  tot: 'https://sg-public-api.hoyolab.com/event/luna/os/sign?act_id=e202202281857121',
}

let hasErrors = false
let latestGames = []

// Retry transient network failures, rate limits, and server errors. Each attempt
// gets its own timeout; only known transient HTTP statuses are retried.
async function fetchWithRetry(url, options, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response
    try {
      response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(20_000)
      })
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`${label} request failed after ${maxAttempts} attempts: ${error.message}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** (attempt - 1))))
      continue
    }

    if (response.status !== 429 && response.status < 500) return response

    if (attempt === maxAttempts) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`${label} returned HTTP ${response.status} after ${maxAttempts} attempts`)
    }

    const retryAfter = Number(response.headers.get('retry-after'))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(10_000, retryAfter * 1000)
      : 1000 * (2 ** (attempt - 1))

    await response.body?.cancel().catch(() => {})
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  throw new Error(`${label} request failed`)
}

/**
 * Checks in one account across the requested games, recording each result via log().
 * A falsy `games` reuses the previous account's list, so multiple accounts sharing
 * the same games need the GAMES line specified only once.
 * @param {string} cookie Cookie header for the account (`ltuid_v2=...; ltoken_v2=...`).
 * @param {string} [games] Space-separated game codes; falsy reuses the prior account's games.
 */
async function run(cookie, games) {
  if (!games) {
    games = latestGames
  } else {
    games = games.split(' ')
    latestGames = games
  }

  for (let game of games) {
    game = game.toLowerCase()

    log('debug', `\n----- CHECKING IN FOR ${game} -----`)

    if (!(game in endpoints)) {
      log('error', `Game ${game} is invalid. Available games are: zzz, gi, hsr, hi3, and tot`)
      continue
    }

    const endpoint = endpoints[game]
    const url = new URL(endpoint)
    const actId = url.searchParams.get('act_id')

    url.searchParams.set('lang', language)

    const body = JSON.stringify({
      lang: language,
      act_id: actId
    })

    // headers from valid browser request
    const headers = new Headers()

    headers.set('accept', 'application/json, text/plain, */*')
    headers.set('accept-encoding', 'gzip, deflate, br, zstd')
    headers.set('accept-language', 'en-US,en;q=0.6')
    headers.set('connection', 'keep-alive')

    headers.set('origin', 'https://act.hoyolab.com')
    headers.set('referrer', 'https://act.hoyolab.com')
    headers.set('content-type', 'application/json;charset=UTF-8')
    headers.set('cookie', cookie)

    headers.set('sec-ch-ua', '"Not/A)Brand";v="8", "Chromium";v="126", "Brave";v="126"')
    headers.set('sec-ch-ua-mobile', '?0')
    headers.set('sec-ch-ua-platform', '"Linux"')
    headers.set('sec-fetch-dest', 'empty')
    headers.set('sec-fetch-mode', 'cors')
    headers.set('sec-fetch-site', 'same-site')
    headers.set('sec-gpc', '1')

    headers.set("x-rpc-signgame", game)

    headers.set('user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

    let res, json
    try {
      res = await fetchWithRetry(url, { method: 'POST', headers, body }, `HoYoLAB ${game}`)
      if (!res.ok) throw new Error(`HoYoLAB returned HTTP ${res.status}`)
      json = await res.json()
      if (!json || typeof json !== 'object' || !('retcode' in json)) {
        throw new Error('HoYoLAB returned an unexpected response')
      }
    } catch (e) {
      log('error', game, `Request failed: ${e.message}`)
      continue
    }

    const code = String(json.retcode)
    const successCodes = {
      '0': 'Successfully checked in!',
      '-5003': 'Already checked in for today',
    }

    if (code in successCodes) {
      log('info', game, `${successCodes[code]}`)
      continue
    }

    const errorCodes = {
      '-100': 'Error not logged in. Your cookie is invalid, try setting up again',
      '-10002': 'Error not found. You haven\'t played this game'
    }

    log('debug', game, `API returned retcode ${code}`)

    if (code in errorCodes) {
      log('error', game, `${errorCodes[code]}`)
      continue
    }

    log('error', game, `Error undocumented, report to Issues page if this persists`)
  }
}

/**
 * Logs to the console and, for non-debug entries, records the message for the
 * Discord and Telegram notifiers. Debug entries print but are never sent, keeping
 * raw responses and cookies out of notifications. An `error` type also sets the
 * process-wide `hasErrors` flag, which makes the run exit non-zero at the end.
 * @param {'info'|'error'|'debug'} type Console method and notification severity.
 * @param {...any} data Message parts; a leading game code is upcased and delimited.
 */
function log(type, ...data) {
  console[type](...data)

  switch (type) {
    case 'debug': return
    case 'error': hasErrors = true
  }

  // Prefix game-specific lines with the upcased code (e.g. `GI:`) for scannability
  if(data[0] in endpoints) {
    data[0] = data[0].toUpperCase() + msgDelimiter
  }

  const string = data
    .map(value => {
      if (typeof value === 'object') {
        return JSON.stringify(value, null, 2).replace(/^"|"$/g, '')
      }

      return value
    })
    .join(' ')

  messages.push({ type, string })
}

// must be function to return early
async function discordWebhookSend() {
  log('debug', '\n----- DISCORD WEBHOOK -----')

  if (!discordWebhook.toLowerCase().trim().startsWith('https://discord.com/api/webhooks/')) {
    log('error', 'DISCORD_WEBHOOK is not a Discord webhook URL. Must start with `https://discord.com/api/webhooks/`')
    return
  }
  let discordMsg = ""
  if (discordUser) {
      discordMsg = `<@${discordUser}>\n`
  }
  discordMsg += messages.map(msg => `${icon[msg.type] ?? ''} ${msg.string}`).join('\n')

  let res
  try {
    res = await fetchWithRetry(discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: discordMsg })
    }, 'Discord notification')
  } catch (error) {
    log('error', `Discord notification failed: ${error.message}`)
    return
  }

  if (res.status === 204) {
    console.log('Successfully sent message to Discord webhook!')
    return
  }

  log('error', 'Error sending message to Discord webhook, please check URL and permissions')
}

// must be function to return early
async function telegramSend() {
  log('debug', '\n----- TELEGRAM -----')

  if (!telegramChat) {
    log('error', 'TELEGRAM_TOKEN is set but TELEGRAM_CHAT_ID is missing')
    return
  }

  const text = messages.map(msg => `${icon[msg.type] ?? ''} ${msg.string}`).join('\n')

  let res
  try {
    res = await fetchWithRetry(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChat, text })
    }, 'Telegram notification')
  } catch (error) {
    log('error', `Telegram notification failed: ${error.message}`)
    return
  }

  if (res.ok) {
    console.log('Successfully sent message to Telegram!')
    return
  }

  log('error', 'Error sending message to Telegram, please check TELEGRAM_TOKEN and TELEGRAM_CHAT_ID')
}

for (const index in cookies) {
  log('info', `-- CHECKING IN FOR ACCOUNT ${Number(index) + 1} --`)
  await run(cookies[index], games[index])
}

if (discordWebhook && URL.canParse(discordWebhook)) {
  await discordWebhookSend()
}

if (telegramToken) {
  await telegramSend()
}

if (hasErrors) {
  console.log('')
  throw new Error('Error(s) occured.')
}
