export default async function handler(req,res) {
  const expected=process.env.ADMIN_TELEGRAM_ID;
  if(req.query.key!==expected) return res.status(401).send('Unauthorized');
  const url=`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`;
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    url:`${process.env.APP_URL}/api/webhook`,
    secret_token:process.env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates:['message','callback_query']
  })});
  const json=await r.json();
  return res.status(r.ok?200:400).json(json);
}
