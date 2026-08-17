import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/supabase.js';
import { sendMessage } from '../lib/telegram.js';

export const config = { api: { bodyParser: false } };
const TZ='America/Chicago';

function classLabel(iso) {
  return new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(iso));
}

async function rawBody(req) {
  const chunks=[];
  for await (const chunk of req) chunks.push(typeof chunk==='string'?Buffer.from(chunk):chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req,res) {
  if(req.method!=='POST') return res.status(405).send('Method not allowed');
  try {
    const body=await rawBody(req);
    const event=stripe.webhooks.constructEvent(body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);

    if(event.type==='checkout.session.completed') {
      const s=event.data.object;
      const bookingId=s.metadata?.booking_id;
      if(bookingId) {
        const { data:b,error }=await supabase.from('bookings').update({
          status:'paid', payment_status:'paid', stripe_payment_intent_id:String(s.payment_intent||''), expires_at:null
        }).eq('id',bookingId).select('*,classes(*)').single();
        if(error) throw error;
        const chatId=s.metadata?.telegram_chat_id;
        if(chatId) await sendMessage(chatId,
          `✅ <b>You’re booked!</b>\n\n${classLabel(b.classes.starts_at)}\n📍 ${b.classes.location}\n\nSee you there 💛`,
          {reply_markup:{inline_keyboard:[[{text:'📅 My Classes',callback_data:'mine'}],[{text:'🏋️ Book another class',callback_data:'book'}]]}}
        );
      }
    }

    if(event.type==='checkout.session.expired') {
      const bookingId=event.data.object.metadata?.booking_id;
      if(bookingId) await supabase.from('bookings').update({status:'cancelled'}).eq('id',bookingId).eq('status','pending');
    }
    return res.status(200).json({received:true});
  } catch(e) {
    console.error(e);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
}
