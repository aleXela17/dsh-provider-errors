/**
 * Readable provider failures for the DeepSeek Harness chat.
 *
 * The `llm/stream` waterfall hands every request to the adapter and returns the
 * chunk stream. A failed request ends with one `finish` chunk whose
 * `reason.failure` carries `{ code, message }`; the chat renders that message
 * verbatim for every code it has no special label for. Providers such as Polza
 * report quota and rate problems as raw HTTP payloads ("402: {...}"), which is
 * what the user actually sees.
 *
 * This plugin wraps the stream, keeps every chunk untouched except that
 * terminal failure, and replaces the message with a short Russian sentence
 * that names the cause and the next step. Balance and per-key limit failures
 * also get a dedicated code, because the chat hides the message for the generic
 * `QUOTA` code and would drop the actionable text again.
 *
 * Only `config.providers` (the ids from `llm-pi-ai.providers`) are touched, and
 * the mapping is pure, so a request never fails because of this plugin.
 *
 * @module @local/dsh-provider-errors
 */

/** Cordis plugin name. */
export const name = 'provider-errors'

/** Failure code for an exhausted balance; unknown to the chat, so the text shows. */
export const QUOTA_CODE = 'PROVIDER_QUOTA'

/** Failure code for an exhausted per-key or daily limit. */
export const LIMIT_CODE = 'PROVIDER_LIMIT'

/** How much of the provider's own text survives in the message. */
const RAW_LIMIT = 400

/** Provider ids covered by default: the ones whose wording these hints use. */
const DEFAULT_PROVIDERS = ['polza-ai']

/**
 * Keep the provider's own words, but bounded.
 * @param {string} text - raw provider text.
 * @returns {string} at most {@link RAW_LIMIT} characters.
 */
function rawText(text) {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.length <= RAW_LIMIT ? trimmed : `${trimmed.slice(0, RAW_LIMIT)}…`
}

/**
 * First HTTP status mentioned in the failure text, if any.
 * @param {string} text - raw provider text.
 * @returns {string | undefined} three-digit status.
 */
function httpStatus(text) {
  const match = text.match(/\b([45]\d{2})\b/)
  return match === null ? undefined : match[1]
}

/**
 * Turn one provider failure into the pair the chat shows.
 *
 * The order of the checks is the priority of the advice: money first, then
 * limits, then the generic transport cases. Anything already recognizable as a
 * harness code (`AUTH`, `TIMEOUT`, ...) keeps that code, so the chat's own
 * label and any recovery UI keep working.
 *
 * @param {{ code?: string, message?: string }} failure - terminal failure.
 * @param {{ provider?: string, model?: string }} options - the model request.
 * @returns {{ code?: string, message: string }} the replacement failure.
 */
export function explainFailure(failure, options = {}) {
  const original = typeof failure?.message === 'string' ? failure.message : ''
  const code = failure?.code
  const text = rawText(original)
  const status = httpStatus(original)
  const model = typeof options.model === 'string' ? options.model : ''
  const where = model === '' ? '' : ` — модель ${model}`

  // 1. Money: an empty balance or a per-key spending cap.
  if (
    code === 'QUOTA' ||
    code === 'ACCOUNT_QUOTA' ||
    status === '402' ||
    /недостаточно средств|insufficient (?:funds|balance|credit|quota)|payment required|billing|top up|пополни|баланс/i.test(original)
  ) {
    return {
      code: QUOTA_CODE,
      message: `Polza: на счёте не хватает денег для этого запроса${where}. Пополните баланс в кабинете polza.ai или снимите лимит расходов у ключа, затем повторите. Ответ провайдера: ${text}`
    }
  }

  // 2. Limits: a daily/per-key cap is not a transient spike.
  if (
    status === '429' &&
    /per (?:day|period|minute|hour)|daily|в день|сутки|суточн|квот|limit.{0,20}(?:day|period)|исчерпан/i.test(original)
  ) {
    return {
      code: LIMIT_CODE,
      message: `Polza: исчерпан лимит запросов по ключу (429)${where}. Подождите сброса лимита или поднимите его в кабинете polza.ai. Ответ провайдера: ${text}`
    }
  }

  // 3. Transient rate limiting: the retry policy owns the code, keep it.
  if (code === 'RATE_LIMIT' || status === '429' || /rate.?limit|too many requests/i.test(original)) {
    return {
      code,
      message: `Polza: слишком много запросов (429)${where}. Повторите через несколько секунд. Ответ провайдера: ${text}`
    }
  }

  // 4. Rejected credentials: the key itself, not the request.
  if (
    code === 'AUTH' ||
    code === 'ACCOUNT_TOKEN_INVALID' ||
    status === '401' ||
    status === '403' ||
    /unauthor|forbidden|invalid.?api|api.?key|invalid.?key|ключ/i.test(original)
  ) {
    return {
      code,
      message: `Polza отклонила ключ API${status === undefined ? '' : ` (${status})`}${where}. Проверьте ключ в «Настройки → Модели» (переменная POLZA_AI_API_KEY): возможно, он отозван или скопирован с опечаткой. Ответ провайдера: ${text}`
    }
  }

  // 5. Provider-side outage.
  if (code === 'SERVER' || (status !== undefined && status.startsWith('5'))) {
    return {
      code,
      message: `Polza: сбой на стороне провайдера (${status ?? '5xx'})${where}. Повторите запрос через минуту. Ответ провайдера: ${text}`
    }
  }

  // 6. Connection problems.
  if (code === 'TIMEOUT' || /timeout|timed out|таймаут/i.test(original)) {
    return {
      code,
      message: `Polza: ответ не пришёл за отведённое время${where}. Проверьте соединение и повторите. Ответ провайдера: ${text}`
    }
  }
  if (
    code === 'TRANSPORT' ||
    /network|ECONN|fetch failed|socket|proxy|прокси|WebSocket/i.test(original)
  ) {
    return {
      code,
      message: `Polza: не удалось соединиться (сеть, прокси или VPN)${where}. Проверьте соединение и повторите. Ответ провайдера: ${text}`
    }
  }

  // 7. Requests the provider rejected on their own merits.
  if (code === 'INVALID_REQUEST' || status === '400' || status === '413' || /invalid.?request|payload too large/i.test(original)) {
    return {
      code,
      message: `Polza отклонила запрос (${status ?? '400'})${where}: обычно дело в размере контекста, картинке или параметрах. Ответ провайдера: ${text}`
    }
  }

  // 8. Nothing recognized: still lead with the provider name so the turn error
  // does not read like a harness bug.
  if (original.trim() === '') {
    return { code, message: `Polza: запрос завершился ошибкой без ответа провайдера${where}.` }
  }
  return {
    code,
    message: `Polza: ошибка провайдера${where}. Ответ провайдера: ${text}`
  }
}

/**
 * Rewrite the terminal failure chunk of a stream, if it is one.
 * @param {unknown} chunk - one chunk from the adapter stream.
 * @param {{ provider?: string, model?: string }} options - the model request.
 * @returns {unknown} the chunk, replaced when it carries a failed terminal.
 */
export function explainChunk(chunk, options) {
  if (chunk === null || typeof chunk !== 'object') return chunk
  if (chunk.type !== 'finish' || chunk.reason === undefined || chunk.reason === null) return chunk
  const { reason } = chunk
  if (reason.kind !== 'error' || reason.failure === undefined || reason.failure === null) return chunk
  const failure = explainFailure(reason.failure, options)
  return { ...chunk, reason: { ...reason, failure } }
}

/**
 * Wrap the downstream stream without altering anything but the terminal failure.
 * @param {AsyncIterable<unknown>} stream - downstream `llm/stream` result.
 * @param {{ provider?: string, model?: string }} options - the model request.
 * @returns {AsyncIterable<unknown>} the wrapped stream.
 */
export function explainStream(stream, options) {
  return (async function* () {
    // An outer listener may hand back a promise instead of the stream itself;
    // awaiting a plain iterable is a no-op, so this covers both contracts.
    const inner = await stream
    for await (const chunk of inner) yield explainChunk(chunk, options)
  })()
}

/**
 * Register the `llm/stream` interception.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ providers?: string[] } | undefined} config - covered provider ids.
 */
export function apply(ctx, config) {
  const providers = new Set(
    Array.isArray(config?.providers) && config.providers.length > 0 ? config.providers : DEFAULT_PROVIDERS
  )
  ctx.on('llm/stream', (options, next) => {
    const stream = next()
    if (!providers.has(options?.provider)) return stream
    return explainStream(stream, options)
  })
}
