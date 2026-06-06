import { OpenAICompatProvider } from "./openai-compat.js";

export class DeepSeekProvider extends OpenAICompatProvider {
  readonly name = "deepseek";
  readonly defaultBaseUrl = "https://api.deepseek.com/v1";
  readonly defaultModels = ["deepseek-v4-flash", "deepseek-v4-pro"];
  readonly envApiKey = "DEEPSEEK_API_KEY";
}
