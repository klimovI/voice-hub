import { useRef, useEffect, useState, useCallback } from 'react';
import { useStore, type ChatMessage } from '../store/useStore';
import { CHAT_MAX_BYTES } from '../sfu/protocol';
import { loadOrCreateClientId } from '../utils/storage';

const MAX_DISPLAY = 200;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

interface Props {
  roomId: string;
  onSend: (text: string, clientMsgId: string) => void;
}

export function ChatPanel({ roomId, onSend }: Props) {
  const messages = useStore((s) => s.chatByRoom[roomId] ?? []);
  const participants = useStore((s) => s.participants);
  const chatSendOptimistic = useStore((s) => s.chatSendOptimistic);
  const persistChat = useStore((s) => s.persistChat);
  const loadChatRoom = useStore((s) => s.loadChatRoom);

  // Hydrate persisted history on mount so chat is visible before joining.
  useEffect(() => {
    loadChatRoom(roomId);
  }, [roomId, loadChatRoom]);

  const selfPeerId = useStore((s) => {
    for (const [id, p] of s.participants) {
      if (p.isSelf) return id;
    }
    return null;
  });
  // Stable per-install identity — independent of join state. Lets MessageRow
  // recognise own messages even after we leave the room (when selfPeerId is null).
  const selfClientId = useRef(loadOrCreateClientId()).current;

  const [text, setText] = useState('');
  const bytes = byteLength(text);
  const overLimit = bytes > CHAT_MAX_BYTES;
  const canSend = text.trim().length > 0 && !overLimit;

  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Track whether user has scrolled away from bottom.
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  // Auto-scroll on new messages only when pinned to bottom.
  const prevLenRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== prevLenRef.current) {
      prevLenRef.current = messages.length;
      if (atBottomRef.current) {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      }
    }
  }, [messages.length]);

  // Auto-resize textarea up to ~5 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || overLimit || !selfPeerId) return;
    const clientMsgId = crypto.randomUUID();
    const now = Date.now();
    const selfEntry = participants.get(selfPeerId);
    chatSendOptimistic(roomId, {
      id: clientMsgId,
      from: selfPeerId,
      text: trimmed,
      ts: now,
      clientMsgId,
      pending: true,
      senderName: selfEntry?.display,
      senderClientId: selfEntry?.clientId,
    });
    persistChat(roomId);
    onSend(trimmed, clientMsgId);
    setText('');
  }, [text, overLimit, selfPeerId, roomId, participants, chatSendOptimistic, persistChat, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const visible = messages.slice(-MAX_DISPLAY);

  return (
    <section className="card p-0! flex flex-col" style={{ height: 691 }}>
      <div className="px-6 pt-5 pb-4 border-b border-line shrink-0">
        <h2 className="card-title">Чат</h2>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 grid content-start gap-0.5"
      >
        {visible.length === 0 && (
          <div className="px-2 py-8 text-center text-muted-2 text-[12px] uppercase tracking-[0.12em]">
            Сообщений пока нет
          </div>
        )}
        {visible.map((msg, i) => {
          const prev = i > 0 ? visible[i - 1] : null;
          const sameSender =
            prev !== null &&
            (prev.senderClientId !== undefined && msg.senderClientId !== undefined
              ? prev.senderClientId === msg.senderClientId
              : prev.from === msg.from);
          const showName = !(sameSender && prev !== null && msg.ts - prev.ts < 5 * 60_000);
          const sameMinute =
            prev !== null && Math.floor(prev.ts / 60_000) === Math.floor(msg.ts / 60_000);
          const showTime = showName || !sameMinute;
          return (
            <MessageRow
              key={msg.id}
              msg={msg}
              participants={participants}
              selfPeerId={selfPeerId}
              selfClientId={selfClientId}
              showName={showName}
              showTime={showTime}
            />
          );
        })}
      </div>

      <div className="px-4 pb-4 pt-3 border-t border-line shrink-0">
        <div
          className={`flex gap-1.5 items-end p-1.5 border ${overLimit ? 'border-danger' : 'border-line'} bg-bg-input focus-within:border-accent transition-[border-color] duration-150`}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Сообщение…"
            rows={1}
            className="flex-1 resize-none bg-transparent px-3 py-2 text-[17px] text-text placeholder:text-muted-2 focus:outline-none disabled:opacity-40"
            style={{ minHeight: 40, maxHeight: 140, lineHeight: '1.4' }}
          />
          <button
            onClick={handleSend}
            disabled={!canSend || !selfPeerId}
            className="btn btn-primary shrink-0 grid place-items-center p-0!"
            style={{ width: 40, height: 40 }}
            aria-label="Отправить"
          >
            <span className="msym" style={{ fontSize: 26 }}>
              send
            </span>
          </button>
        </div>
        {bytes > CHAT_MAX_BYTES * 0.8 && (
          <div
            className={`mt-1 text-right text-[11px] tabular-nums ${overLimit ? 'text-danger' : 'text-muted-2'}`}
          >
            {bytes}/{CHAT_MAX_BYTES}
          </div>
        )}
      </div>
    </section>
  );
}

type MessageRowProps = {
  msg: ChatMessage;
  participants: Map<string, import('../types').ParticipantUI>;
  selfPeerId: string | null;
  selfClientId: string;
  showName: boolean;
  showTime: boolean;
};

function MessageRow({
  msg,
  participants,
  selfPeerId,
  selfClientId,
  showName,
  showTime,
}: MessageRowProps) {
  const isSelf =
    msg.senderClientId !== undefined
      ? msg.senderClientId === selfClientId
      : msg.from === selfPeerId;
  const senderName =
    msg.senderName ?? participants.get(msg.from)?.display ?? (isSelf ? 'Вы' : 'Неизвестный');

  return (
    <div className={`px-2 ${showName ? 'pt-2' : ''} ${msg.pending ? 'opacity-50' : ''}`}>
      {showName && (
        <div
          className={`text-[11px] font-bold uppercase tracking-[0.14em] truncate mb-0.5 ${isSelf ? 'text-accent' : 'text-muted'}`}
        >
          {senderName}
        </div>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-baseline">
        <p className="m-0 text-[17px] text-body break-words whitespace-pre-wrap">{msg.text}</p>
        {showTime && (
          <span className="text-[11px] text-muted-2 tabular-nums shrink-0">
            {formatTime(msg.ts)}
          </span>
        )}
      </div>
    </div>
  );
}
