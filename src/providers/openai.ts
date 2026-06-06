import { OpenAICompatProvider } from "./openai-compat.js";

export class OpenAIProvider extends OpenAICompatProvider {
  readonly name = "openai";
  readonly defaultBaseUrl = "https://api.openai.com/v1";
  readonly defaultModels = ["gpt-4o", "gpt-4o-mini"];
  readonly envApiKey = "OPENAI_API_KEY";
}
