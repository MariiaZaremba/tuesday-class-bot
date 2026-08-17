const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function tg(method, body) {
  const res = await fetch(`${API()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(json)}`);
  return json.result;
}

export const sendMessage = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });

export const answerCallback = (callback_query_id, text = '') =>
  tg('answerCallbackQuery', { callback_query_id, text });
