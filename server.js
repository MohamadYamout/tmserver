const express = require('express');
const cors = require('cors');
const stripe = require('stripe')('sk_test_51RFFTVP7nor4gZvlFZ5673pw9LycCABZp7VYnDU6Twq9Sz1bSy44KaWwMxMsVEMbgJ706I1PQJ4IqmdLINnQO3Eg002r8XHlQb');
const { Pool } = require('pg');

const app = express();
const PORT = 3000;

// Signing secret from your Stripe Dashboard webhook
const WEBHOOK_SECRET = 'whsec_N0auuIcqWGGDq79EaoHmlMtSmSvwElMo';

const pool = new Pool({
  user: 'postgres',
  host: 'ticketmasterplusdb.cl02waq8g8l3.eu-west-1.rds.amazonaws.com',
  database: 'TMDB',
  password: 'TMADMIN-6',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());

// 1) Webhook — raw body for signature
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('❌ Webhook signature failed:', err.message);
      return res.sendStatus(400);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const concertName = session.metadata.concertName;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        const { rowCount, rows } = await client.query(
          `UPDATE TM.tickets
             SET numTickets = numTickets - 1
           WHERE concertName = $1
             AND numTickets > 0
         RETURNING numTickets;`,
          [concertName]
        );

        if (rowCount === 0) {
          // sold out → cancel the authorization
          await stripe.paymentIntents.cancel(session.payment_intent);
        } else {
          // ticket reserved → capture the payment
          await stripe.paymentIntents.capture(session.payment_intent);
          console.log(`✔ Captured payment; remaining tickets: ${rows[0].numtickets}`);
        }

        await client.query('COMMIT');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        console.error('🔄 DB transaction error:', dbErr);
      } finally {
        client.release();
      }
    }

    res.json({ received: true });
  }
);

// 2) JSON parser for all other endpoints
app.use(express.json());

// 3) List concerts
app.get('/concerts', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        concertName    AS "concertName",
        location,
        concertDate,
        artist,
        numTickets     AS "numTickets",
        ticketPrice    AS "ticketPrice"
      FROM TM.tickets;
    `);
    res.json(rows);
  } catch (err) {
    console.error('DB error (GET /concerts):', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

// 4) Create Checkout Session (manual capture)
app.post('/create-checkout-session', async (req, res) => {
  const { concertName } = req.body;

  // availability check
  try {
    const { rows } = await pool.query(
      `SELECT numTickets FROM TM.tickets WHERE concertName = $1`,
      [concertName]
    );
    if (!rows.length || rows[0].numtickets <= 0) {
      return res.status(400).json({ error: 'Sold out' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Could not check availability' });
  }

  // price lookup
  let unit_amount = 5000;
  try {
    const { rows } = await pool.query(
      `SELECT ticketPrice FROM TM.tickets WHERE concertName = $1`,
      [concertName]
    );
    if (rows.length) {
      const priceDollars = parseFloat(rows[0].ticketprice);
      if (!isNaN(priceDollars)) unit_amount = Math.round(priceDollars * 100);
    }
  } catch { }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: concertName },
          unit_amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      payment_intent_data: {
        capture_method: 'manual'
      },
      success_url: `https://s3.eu-west-1.amazonaws.com/ticketmasterplus.com/pages/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: 'https://s3.eu-west-1.amazonaws.com/ticketmasterplus.com/pages/concerts.html',
      metadata: { concertName }
    });

    res.json({ sessionId: session.id });
  } catch (stripeErr) {
    console.error('Stripe session error:', stripeErr);
    res.status(500).json({ error: 'Unable to create checkout session' });
  }
});

// 5) Session‑status endpoint
app.get('/checkout-session', async (req, res) => {
  const { session_id } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
    return res.json({
      intent_status: pi.status,
      concertName: session.metadata.concertName
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () =>
  console.log(`📀 Backend running`)
);
