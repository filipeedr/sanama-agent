import { getServerEnv } from './env';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
}

interface ChatOptions {
  maxOutputTokens?: number;
  temperature?: number;
}

export async function generateSummaryFromText(title: string, text: string): Promise<string> {
  const prompt = `Você é um assistente jurídico que serve para tirar dúvidas sobre documentos contratuais, legais e seus termos aditivos.\n` +
    `Responda de forma clara e objetiva, sem perder detalhes importantes.\n` +
    `Se a pergunta não for sobre o documento, responda que não temos informações sobre o assunto.\n` +
    `Você deve fornecer embasamento na resposta consideranto todos os arquivos do notebook.\n` +
    `Título: ${title}\n\nTexto:\n${text.slice(0, 4000)}`;
  const env = getServerEnv();
  const [message] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Você é um assistente jurídico que serve para tirar dúvidas sobre documentos contratuais, legais e seus termos atividos. Responda de forma clara e objetiva, sem perder detalhes importantes. Se a pergunta não for sobre o documento, responda que não temos informações sobre o assunto. Você deve fornecer embasamento na resposta consideranto todos os arquivos do notebook. Responda sempre em Português Brasileiro.'
      },
      { role: 'user', content: prompt }
    ],
    { maxOutputTokens: env.SUMMARY_MAX_OUTPUT_TOKENS }
  );
  return message;
}

export async function generateChatTitleFromQuestion(question: string): Promise<string> {
  const [raw] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Gere títulos curtos para conversas sobre documentos jurídicos. O título deve ter no máximo 30 caracteres, ser descritivo e não conter pontos finais.'
      },
      {
        role: 'user',
        content: `Crie um título resumido (<=30 caracteres) para esta pergunta:\n${question}`
      }
    ],
    { maxOutputTokens: 40, temperature: 0.2 }
  );

  const sanitized = raw.replace(/\s+/g, ' ').trim();
  const truncated = sanitized.slice(0, 30).trim();
  if (truncated.length) {
    return truncated;
  }
  return question.slice(0, 30).trim() || 'Novo chat';
}

export async function callChatModel(messages: ChatMessage[], options?: ChatOptions): Promise<string[]> {
  const env = getServerEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Configure-a para habilitar o chat.');
  }
  const response = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL_CHAT,
      messages,
      max_tokens: options?.maxOutputTokens ?? env.CHAT_MAX_OUTPUT_TOKENS,
      temperature: options?.temperature ?? 0.3
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Erro no LLM: ${body}`);
  }

  const data = (await response.json()) as ChatResponse;
  return data.choices.map((choice) => choice.message.content);
}
