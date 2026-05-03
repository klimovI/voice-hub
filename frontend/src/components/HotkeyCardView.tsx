import { formatBinding } from '../utils/binding';
import { type HotkeyApi } from '../hooks/useKeyboardCapture';

export function HotkeyCardView({ api }: { api: HotkeyApi }) {
  let display: string;
  if (api.capturing) {
    display = api.liveKeys.length > 0 ? api.liveKeys.join(' + ') : 'Зажмите комбинацию…';
  } else {
    display = formatBinding(api.binding);
  }

  return (
    <section className="card grid gap-[14px]">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="card-title">Кнопка для микрофона</h2>
      </div>
      <label className="block text-[12px] font-medium text-muted">
        Нажмите на поле и зажмите комбинацию
        <input
          id="shortcut-input"
          type="text"
          readOnly
          value={display}
          onClick={api.start}
          onBlur={api.cancel}
          className="input-field cursor-pointer"
        />
      </label>
      <p className="text-[11px] text-muted leading-snug -mt-1">
        Совет: модификатор (Ctrl / Shift / Alt) и клавиша или боковая кнопка мыши. Зажмите
        комбинацию одновременно и отпустите — запишется при отпускании.
      </p>
      <div className="flex flex-wrap gap-2.5">
        <button
          id="shortcut-reset"
          type="button"
          onClick={api.reset}
          disabled={api.capturing}
          className="btn btn-secondary btn-mini"
        >
          По умолчанию
        </button>
        <button
          id="shortcut-clear"
          type="button"
          onClick={api.clear}
          disabled={api.capturing || !api.binding}
          className="btn btn-danger btn-mini"
        >
          Очистить
        </button>
        {api.capturing ? (
          <button
            id="shortcut-cancel"
            type="button"
            onClick={api.cancel}
            className="btn btn-secondary btn-mini"
          >
            Отмена
          </button>
        ) : null}
      </div>
    </section>
  );
}
