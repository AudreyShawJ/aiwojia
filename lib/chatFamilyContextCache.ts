/**
 * 聊天页会缓存家庭成员与近期记录；家庭成员页返回或关联变更后应失效，避免亲属推理用旧数据。
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** 聊天组件挂载时订阅，在回调里将 cacheRef 置空 */
export function subscribeChatFamilyContextCacheInvalidate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function invalidateChatFamilyContextCache(): void {
  listeners.forEach(l => {
    try {
      l();
    } catch {
      /* ignore */
    }
  });
}
