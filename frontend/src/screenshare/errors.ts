import type { ScreenShareReason } from '../sfu/protocol';

export function screenShareErrorRu(reason: ScreenShareReason): string | null {
  switch (reason) {
    case 'not-found':
      return 'Сессия демонстрации не найдена.';
    case 'invalid-token':
      return 'Не удалось восстановить демонстрацию. Поделитесь экраном заново.';
    case 'already-publishing':
      return 'Вы уже делитесь экраном.';
    case 'internal':
      return 'Ошибка сервера демонстрации.';
    default:
      return null;
  }
}
