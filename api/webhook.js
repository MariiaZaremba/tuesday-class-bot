import { supabase } from '../lib/supabase.js';
import { sendMessage, answerCallback } from '../lib/telegram.js';

const TZ = 'America/Chicago';
const ADMIN_ID = String(process.env.ADMIN_TELEGRAM_ID || '');

function money(cents) {
  return `$${(cents / 100).toFixed(0)}`;
}

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

function isAdmin(id) {
  return String(id) === ADMIN_ID;
}

async function upsertUser(from, chatId) {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      {
        telegram_id: from.id,
        chat_id: chatId,
        first_name: from.first_name || null,
        last_name: from.last_name || null,
        username: from.username || null
      },
      { onConflict: 'telegram_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

const homeKeyboard = {
  inline_keyboard: [
    [{ text: '🏋️ Book a Class', callback_data: 'book' }],
    [{ text: '📅 My Classes', callback_data: 'mine' }],
    [{ text: '👤 My Profile', callback_data: 'profile' }]
  ]
};

async function showHome(chatId, firstName = '') {
  await sendMessage(
    chatId,
    `<b>Tuesday Training</b> 💛\n${
      firstName ? `Hi, ${firstName}!\n\n` : ''
    }Book your class, pay, and keep track of your attendance here.`,
    {
      reply_markup: homeKeyboard
    }
  );
}

async function showAvailable(chatId) {
  const { data, error } = await supabase
    .from('class_availability')
    .select('*')
    .eq('status', 'open')
    .gt('starts_at', new Date().toISOString())
    .order('starts_at')
    .limit(8);

  if (error) throw error;

  if (!data?.length) {
    return sendMessage(
      chatId,
      'No upcoming classes are posted yet. 💛',
      {
        reply_markup: homeKeyboard
      }
    );
  }

  const rows = data.map((c) => [
    {
      text: `${classLabel(c.starts_at)} · ${c.spots_left} spot${
        c.spots_left === 1 ? '' : 's'
      } · ${money(c.price_cents)}`,
      callback_data: `class:${c.id}`
    }
  ]);

  rows.push([{ text: '← Back', callback_data: 'home' }]);

  await sendMessage(chatId, '<b>Choose a class:</b>', {
    reply_markup: {
      inline_keyboard: rows
    }
  });
}

async function showClass(chatId, classId) {
  const { data: c, error } = await supabase
    .from('class_availability')
    .select('*')
    .eq('id', classId)
    .single();

  if (error) throw error;

  await sendMessage(
    chatId,
    `<b>${classLabel(c.starts_at)}</b>\n📍 ${c.location}\n💳 ${money(
      c.price_cents
    )}\n👥 ${c.spots_left} spot${c.spots_left === 1 ? '' : 's'} left`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                c.spots_left > 0
                  ? `Book & Pay ${money(c.price_cents)}`
                  : 'Class Full',
              callback_data:
                c.spots_left > 0 ? `pay:${c.id}` : 'book'
            }
          ],
          [{ text: '← Back', callback_data: 'book' }]
        ]
      }
    }
  );
}

async function createCheckout(chatId, user, classId) {
  // Stripe is optional at this stage.
  // Bot can work without Stripe until we connect payments.
  if (!process.env.STRIPE_SECRET_KEY) {
    return sendMessage(
      chatId,
      'Payments are not connected yet. Please try again later. 💛',
      {
        reply_markup: homeKeyboard
      }
    );
  }

  // IMPORTANT:
  // Stripe is imported only when payment is actually needed.
  const { stripe } = await import('../lib/stripe.js');

  const { data: booking, error: reserveError } = await supabase.rpc(
    'reserve_class_slot',
    {
      p_user_id: user.id,
      p_class_id: classId
    }
  );

  if (reserveError) {
    const message = reserveError.message || '';

    if (message.includes('CLASS_FULL')) {
      return sendMessage(
        chatId,
        'That class just filled up. Please choose another date.'
      );
    }

    throw reserveError;
  }

  if (booking.status === 'paid') {
    return sendMessage(
      chatId,
      'You’re already booked for this class ✅',
      {
        reply_markup: homeKeyboard
      }
    );
  }

  const { data: c, error } = await supabase
    .from('classes')
    .select('*')
    .eq('id', classId)
    .single();

  if (error) throw error;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',

    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: c.price_cents,
          product_data: {
            name: `Tuesday Training — ${classLabel(c.starts_at)}`
          }
        },
        quantity: 1
      }
    ],

    metadata: {
      booking_id: booking.id,
      user_id: user.id,
      class_id: c.id,
      telegram_chat_id: String(chatId)
    },

    success_url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}`,
    cancel_url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}`,

    expires_at: Math.floor(Date.now() / 1000) + 30 * 60
  });

  await supabase
    .from('bookings')
    .update({
      stripe_checkout_session_id: session.id
    })
    .eq('id', booking.id);

  await sendMessage(
    chatId,
    `Your spot is held for <b>15 minutes</b>. Complete payment to confirm your booking.`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `💳 Pay ${money(c.price_cents)}`,
              url: session.url
            }
          ],
          [{ text: '← My Classes', callback_data: 'mine' }]
        ]
      }
    }
  );
}

async function showMine(chatId, user) {
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id,status,payment_status,attended,expires_at,classes(id,starts_at,location)'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const valid = (data || []).filter((b) => b.status === 'paid');

  const now = new Date();

  const upcoming = valid
    .filter((b) => new Date(b.classes.starts_at) > now)
    .sort(
      (a, b) =>
        new Date(a.classes.starts_at) -
        new Date(b.classes.starts_at)
    );

  const past = valid
    .filter((b) => new Date(b.classes.starts_at) <= now)
    .sort(
      (a, b) =>
        new Date(b.classes.starts_at) -
        new Date(a.classes.starts_at)
    );

  let text = '<b>📅 My Classes</b>\n\n';

  text += '<b>Upcoming</b>\n';

  text += upcoming.length
    ? upcoming
        .map(
          (b) => `✅ ${classLabel(b.classes.starts_at)}`
        )
        .join('\n')
    : 'No upcoming bookings.';

  text += '\n\n<b>Past</b>\n';

  text += past.length
    ? past
        .slice(0, 10)
        .map(
          (b) =>
            `${
              b.attended === true
                ? '✅'
                : b.attended === false
                ? '—'
                : '•'
            } ${classLabel(b.classes.starts_at)}${
              b.attended === true
                ? ' · Attended'
                : b.attended === false
                ? ' · Missed'
                : ''
            }`
        )
        .join('\n')
    : 'No classes yet.';

  await sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🏋️ Book another class',
            callback_data: 'book'
          }
        ],
        [{ text: '← Home', callback_data: 'home' }]
      ]
    }
  });
}

async function showProfile(chatId, user) {
  const { data, error } = await supabase
    .from('bookings')
    .select('attended,status')
    .eq('user_id', user.id)
    .eq('status', 'paid');

  if (error) throw error;

  const total = data?.length || 0;

  const attended =
    data?.filter((x) => x.attended === true).length || 0;

  await sendMessage(
    chatId,
    `<b>👤 My Profile</b>\n\n${
      user.first_name || ''
    }${
      user.last_name ? ' ' + user.last_name : ''
    }\nClasses booked: <b>${total}</b>\nClasses attended: <b>${attended}</b>`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📅 My Classes', callback_data: 'mine' }],
          [{ text: '← Home', callback_data: 'home' }]
        ]
      }
    }
  );
}

function zonedDateToUtc(
  year,
  month,
  day,
  hour,
  minute,
  timeZone = TZ
) {
  let guess = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute
  );

  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(guess));

    const get = (type) =>
      Number(
        parts.find((p) => p.type === type).value
      );

    const represented = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute')
    );

    guess +=
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute
      ) - represented;
  }

  return new Date(guess);
}

async function seedClasses(chatId) {
  const nowLocal = new Date(
    new Date().toLocaleString('en-US', {
      timeZone: TZ
    })
  );

  const day = nowLocal.getDay();

  let daysToTuesday =
    (2 - day + 7) % 7;

  if (
    daysToTuesday === 0 &&
    nowLocal.getHours() >= 19
  ) {
    daysToTuesday = 7;
  }

  const first = new Date(
    nowLocal.getFullYear(),
    nowLocal.getMonth(),
    nowLocal.getDate() + daysToTuesday
  );

  const rows = [];

  for (let i = 0; i < 8; i++) {
    const d = new Date(
      first.getFullYear(),
      first.getMonth(),
      first.getDate() + 7 * i
    );

    rows.push({
      starts_at: zonedDateToUtc(
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate(),
        19,
        0
      ).toISOString(),

      location:
        process.env.CLASS_LOCATION ||
        'Northbrook, IL',

      capacity: Number(
        process.env.CLASS_CAPACITY || 8
      ),

      price_cents: Number(
        process.env.CLASS_PRICE_CENTS || 1500
      )
    });
  }

  let created = 0;

  for (const row of rows) {
    const { data: exists } = await supabase
      .from('classes')
      .select('id')
      .eq('starts_at', row.starts_at)
      .maybeSingle();

    if (!exists) {
      const { error } = await supabase
        .from('classes')
        .insert(row);

      if (error) throw error;

      created++;
    }
  }

  await sendMessage(
    chatId,
    `✅ Added ${created} new Tuesday class${
      created === 1 ? '' : 'es'
    }.`
  );
}

async function showAdmin(chatId) {
  const { data, error } = await supabase
    .from('class_availability')
    .select('*')
    .gt(
      'starts_at',
      new Date(
        Date.now() - 6 * 60 * 60 * 1000
      ).toISOString()
    )
    .order('starts_at')
    .limit(6);

  if (error) throw error;

  const rows = (data || []).map((c) => [
    {
      text: `${classLabel(
        c.starts_at
      )} · ${c.capacity - c.spots_left}/${
        c.capacity
      }`,
      callback_data: `adm:${c.id}`
    }
  ]);

  rows.push([
    {
      text: '➕ Add next 8 Tuesdays',
      callback_data: 'seed'
    }
  ]);

  await sendMessage(
    chatId,
    '<b>Admin · Classes</b>',
    {
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

async function showRoster(chatId, classId) {
  const { data: c } = await supabase
    .from('classes')
    .select('*')
    .eq('id', classId)
    .single();

  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id,attended,status,users(first_name,last_name)'
    )
    .eq('class_id', classId)
    .eq('status', 'paid')
    .order('created_at');

  if (error) throw error;

  const rows = (data || []).map((b) => [
    {
      text: `${
        b.attended === true ? '✅ ' : ''
      }${b.users?.first_name || 'Client'} ${
        b.users?.last_name || ''
      }`,
      callback_data: `att:${b.id}`
    }
  ]);

  rows.push([
    {
      text: '← Admin',
      callback_data: 'admin'
    }
  ]);

  await sendMessage(
    chatId,
    `<b>${classLabel(
      c.starts_at
    )}</b>\nPaid: ${
      data?.length || 0
    }/${
      c.capacity
    }\n\nTap a name to toggle check-in.`,
    {
      reply_markup: {
        inline_keyboard: rows
      }
    }
  );
}

async function toggleAttendance(
  chatId,
  bookingId
) {
  const { data: b, error } = await supabase
    .from('bookings')
    .select('attended,class_id')
    .eq('id', bookingId)
    .single();

  if (error) throw error;

  await supabase
    .from('bookings')
    .update({
      attended:
        b.attended === true ? null : true
    })
    .eq('id', bookingId);

  await showRoster(chatId, b.class_id);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res
      .status(405)
      .send('Method not allowed');
  }

  const secret =
    req.headers[
      'x-telegram-bot-api-secret-token'
    ];

  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    secret !==
      process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return res
      .status(401)
      .send('Unauthorized');
  }

  try {
    const update = req.body;

    if (update.message) {
      const { message } = update;

      const user = await upsertUser(
        message.from,
        message.chat.id
      );

      const text = message.text || '';

      if (text === '/start') {
        await showHome(
          message.chat.id,
          user.first_name
        );
      } else if (
        text === '/admin' &&
        isAdmin(message.from.id)
      ) {
        await showAdmin(message.chat.id);
      } else if (
        text === '/seed' &&
        isAdmin(message.from.id)
      ) {
        await seedClasses(message.chat.id);
      } else {
        await showHome(
          message.chat.id,
          user.first_name
        );
      }
    } else if (update.callback_query) {
      const q = update.callback_query;

      const chatId = q.message.chat.id;

      const user = await upsertUser(
        q.from,
        chatId
      );

      const d = q.data || '';

      await answerCallback(q.id);

      if (d === 'home') {
        await showHome(
          chatId,
          user.first_name
        );
      } else if (d === 'book') {
        await showAvailable(chatId);
      } else if (d === 'mine') {
        await showMine(chatId, user);
      } else if (d === 'profile') {
        await showProfile(chatId, user);
      } else if (
        d.startsWith('class:')
      ) {
        await showClass(
          chatId,
          d.slice(6)
        );
      } else if (
        d.startsWith('pay:')
      ) {
        await createCheckout(
          chatId,
          user,
          d.slice(4)
        );
      } else if (
        isAdmin(q.from.id) &&
        d === 'admin'
      ) {
        await showAdmin(chatId);
      } else if (
        isAdmin(q.from.id) &&
        d === 'seed'
      ) {
        await seedClasses(chatId);
      } else if (
        isAdmin(q.from.id) &&
        d.startsWith('adm:')
      ) {
        await showRoster(
          chatId,
          d.slice(4)
        );
      } else if (
        isAdmin(q.from.id) &&
        d.startsWith('att:')
      ) {
        await toggleAttendance(
          chatId,
          d.slice(4)
        );
      }
    }

    return res
      .status(200)
      .json({ ok: true });
  } catch (e) {
    console.error(e);

    return res
      .status(200)
      .json({ ok: true });
  }
}
