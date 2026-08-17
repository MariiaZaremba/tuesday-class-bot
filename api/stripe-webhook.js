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
      let bookingId = s.metadata?.booking_id;

if (!bookingId && s.metadata?.user_id && s.metadata?.class_id) {
  const { data: fallbackBooking, error: fallbackError } = await supabase
    .from('bookings')
    .select('id')
    .eq('user_id', s.metadata.user_id)
    .eq('class_id', s.metadata.class_id)
    .maybeSingle();

  if (fallbackError) throw fallbackError;

  bookingId = fallbackBooking?.id;
}

if (bookingId) {
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
