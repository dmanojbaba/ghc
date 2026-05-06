interface Env {
  CATT_API_KEY: string;
  CATT_BACKEND_SECRET: string;
  CATT_BACKEND_URL: string;
  CATT_AI: Ai;
  DEVICE_QUEUE: DurableObjectNamespace;
  CALLER_KV: KVNamespace;
  SLACK_SIGNING_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_CHAT_IDS: string;
  TELEGRAM_SECRET_TOKEN: string;
  YOUTUBE_API_KEY: string;
  REDIRECT_URL: string;
}
