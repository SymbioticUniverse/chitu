import { OpenAICompatProvider } from "./openai-compat.js";

export class DeepSeekProvider extends OpenAICompatProvider {
  readonly name = "deepseek";
  readonly defaultBaseUrl = "https://api.deepseek.com/v1";
  readonly defaultModels = ["deepseek-v4-pro", "deepseek-v4-flash"];
  readonly envApiKey = "DEEPSEEK_API_KEY";
}
