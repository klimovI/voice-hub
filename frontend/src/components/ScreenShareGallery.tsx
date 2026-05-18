import { useScreenShareStore } from '../store/useScreenShareStore';
import { ScreenShareTile } from './ScreenShareTile';
import { useStore } from '../store/useStore';

interface Props {
  /** Called when a tile is clicked. Owner manages the gen-counter race guard. */
  onTileClick: (publisherId: string) => void;
}

/**
 * Responsive grid of placeholder tiles, one per active screen share in the
 * room. Hidden entirely when no shares are active so the chat / participants
 * panels keep their default layout.
 *
 * Filters out the caller's own share — there's no point letting users
 * subscribe to themselves; the publisher view is the picker preview.
 */
export function ScreenShareGallery({ onTileClick }: Props) {
  const shares = useScreenShareStore((s) => s.shares);
  // selectSelfPeerId is over-engineered here — we keep a direct iteration so
  // the gallery re-renders only on shares/participants changes, not on the
  // sort comparator's stable identity.
  const selfId = useStore((s) => {
    for (const [id, p] of s.participants) {
      if (p.isSelf) return id;
    }
    return null;
  });

  const list = Array.from(shares.values()).filter((share) => share.publisherId !== selfId);
  if (list.length === 0) return null;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-1">
        Демонстрации экрана
      </h3>
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(180px,1fr))]">
        {list.map((share) => (
          <ScreenShareTile
            key={share.publisherId}
            publisherId={share.publisherId}
            hasSystemAudio={share.hasSystemAudio}
            onClick={() => onTileClick(share.publisherId)}
          />
        ))}
      </div>
    </section>
  );
}
