interface TelegramEnvelope {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error_code?: number;
  readonly description?: string;
}

export class TelegramExplicitError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: number | undefined,
    readonly description: string
  ) {
    super(`Telegram rejected request (${status}): ${description}`);
    this.name = 'TelegramExplicitError';
  }
}

export class TelegramUnknownResultError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TelegramUnknownResultError';
  }
}

export interface TelegramReceipt {
  readonly messageId: string;
}

export interface TelegramMessageOptions {
  readonly parseMode: 'HTML';
  readonly disableLinkPreview: true;
  readonly button: {
    readonly text: string;
    readonly url: string;
  };
}

export interface TelegramTransportLike {
  sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
    options?: TelegramMessageOptions
  ): Promise<TelegramReceipt>;
  editMessage(
    chatId: string,
    messageId: string,
    text: string,
    signal?: AbortSignal,
    options?: TelegramMessageOptions
  ): Promise<void>;
}

export class TelegramTransport implements TelegramTransportLike {
  constructor(
    private readonly botToken: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 5_000
  ) {}

  async sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
    options?: TelegramMessageOptions
  ): Promise<TelegramReceipt> {
    const result = await this.call(
      'sendMessage',
      { chat_id: chatId, text, ...this.presentationBody(options) },
      signal
    );
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new TelegramUnknownResultError('Telegram send result has an invalid shape');
    }
    const messageId = (result as Record<string, unknown>).message_id;
    if (typeof messageId !== 'number' && typeof messageId !== 'string') {
      throw new TelegramUnknownResultError('Telegram send result has no message ID');
    }
    return { messageId: String(messageId) };
  }

  async editMessage(
    chatId: string,
    messageId: string,
    text: string,
    signal?: AbortSignal,
    options?: TelegramMessageOptions
  ): Promise<void> {
    await this.call(
      'editMessageText',
      { chat_id: chatId, message_id: messageId, text, ...this.presentationBody(options) },
      signal
    );
  }

  private presentationBody(options: TelegramMessageOptions | undefined): Record<string, unknown> {
    if (options === undefined) return {};
    return {
      parse_mode: options.parseMode,
      link_preview_options: { is_disabled: options.disableLinkPreview },
      reply_markup: {
        inline_keyboard: [[{ text: options.button.text, url: options.button.url }]]
      }
    };
  }

  private async call(
    method: 'sendMessage' | 'editMessageText',
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort('telegram_timeout'), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        throw new TelegramUnknownResultError('Telegram response result is unknown', error);
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TelegramUnknownResultError('Telegram response envelope is invalid');
      }
      const envelope = parsed as TelegramEnvelope;
      if (
        envelope.ok === false &&
        typeof envelope.error_code === 'number' &&
        typeof envelope.description === 'string'
      ) {
        throw new TelegramExplicitError(
          response.status,
          envelope.error_code,
          envelope.description
        );
      }
      if (!response.ok || envelope.ok !== true) {
        throw new TelegramUnknownResultError('Telegram response result is unknown');
      }
      return envelope.result;
    } catch (error) {
      if (error instanceof TelegramExplicitError || error instanceof TelegramUnknownResultError) {
        throw error;
      }
      throw new TelegramUnknownResultError('Telegram request result is unknown', error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
