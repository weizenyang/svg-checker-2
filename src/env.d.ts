/// <reference types="astro/client" />

interface ImportMetaEnv {
	/** Optional override for OpenRouter base URL; omit to use default (no API key needed at build time). */
	readonly PUBLIC_OPENROUTER_CHAT_URL?: string;
	/** OpenRouter API key (embedded in client bundle — use only for local/dev or non-public deploys). */
	readonly PUBLIC_OPENROUTER_API_KEY?: string;
}
