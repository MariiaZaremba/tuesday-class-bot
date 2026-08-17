import { stripe } from '../lib/stripe.js';
import { supabase } from '../lib/supabase.js';
import { sendMessage } from '../lib/telegram.js';

export const config = {
  api: {
    bodyParser: false
  }
};

const TZ = 'America/Chicago';

function classLabel(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(iso));
}

async function rawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk
    );
  }

  return Buffer.concat(chunks);
}

async function findBookingId(session) {
  let bookingId = session.metadata?.booking_id || null;

  if (
    !bookingId &&
    session.metadata?.user_id &&
    session.metadata?.class_id
  ) {
    const { data, error } = await supabase
      .from('bookings')
      .select('id')
      .eq('user_id', session.metadata.user_id)
      .eq('class_id', session.metadata.class_id)
      .maybeSingle();

    if (error) throw error;
    bookingId = data?.id || null;
  }

  return bookingId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const body = await rawBody(req);
    const signature = req.headers['stripe-signature'];

    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bookingId = await findBookingId(session);

      if (!bookingId) {
        throw new Error('Booking ID not found for completed checkout session');
      }

      const { data: booking, error } = await supabase
        .from('bookings')
        .update({
          status: 'paid',
          payment_status: 'paid',
          stripe_payment_intent_id: String(session.payment_intent || ''),
          expires_at: null
        })
        .eq('id', bookingId)
        .select('*,classes(*)')
        .single();

      if (error) throw error;

      const chatId = session.metadata?.telegram_chat_id;

      if (chatId && booking?.classes) {
        await sendMessage(
          chatId,
          `✅ <b>You’re booked!</b>\n\n${classLabel(booking.classes.starts_at)}\n📍 ${booking.classes.location}\n\nSee you there 💛`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📅 My Classes', callback_data: 'mine' }],
                [{ text: '🏋️ Book another class', callback_data: 'book' }]
              ]
            }
          }
        );
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const bookingId = await findBookingId(session);

      if (bookingId) {
        const { error } = await supabase
          .from('bookings')
          .update({ status: 'cancelled' })
          .eq('id', bookingId)
          .eq('status', 'pending');

        if (error) throw error;
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    return res
      .status(400)
      .send(`Webhook error: ${error?.message || 'Unknown error'}`);
  }
}
