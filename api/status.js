export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ modelConfigured: !!(process.env.MODEL_API_KEY && process.env.MODEL_NAME), model: process.env.MODEL_NAME || null, tokenRequired: !!process.env.APP_ACCESS_TOKEN, hosted: !!process.env.VERCEL }));
}
