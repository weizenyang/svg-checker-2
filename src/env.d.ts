/// <reference types="astro/client" />

interface ImportMetaEnv {
	/** Optional override for OpenRouter base URL; omit to use default (no API key needed at build time). */
	readonly PUBLIC_OPENROUTER_CHAT_URL?: string;
	/** OpenRouter API key (embedded in client bundle — use only for local/dev or non-public deploys). */
	readonly PUBLIC_OPENROUTER_API_KEY?: string;
	/** Google Gemini API key for direct Gemini API (not OpenRouter). */
	readonly PUBLIC_GEMINI_API_KEY?: string;
	/** Optional override for Gemini REST base URL. */
	readonly PUBLIC_GEMINI_API_BASE?: string;
}
