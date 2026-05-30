import {

  useCallback,

  useEffect,

  useMemo,

  useRef,

  useState,

  type MouseEvent as ReactMouseEvent,

  type ReactElement,

  type TouchEvent as ReactTouchEvent,

} from "react";

import type { KnowledgeNode } from "@chatting-cursor/shared";

import {

  createKnowledgeNode,

  deleteKnowledgeNode,

  fetchKnowledgeTree,

  renameKnowledgeNode,

  uploadKnowledgeMarkdown,

} from "../api/bridge";





interface KnowledgeWikiSectionProps {

  bridgeUrl: string;

  bridgeToken: string;

}





interface ContextMenuState {

  nodeId: string;

  x: number;

  y: number;

}





const LONG_PRESS_MS = 520;

const DEFAULT_CHILD_PREFIX = "新建节点";





function buildChildrenMap(nodes: KnowledgeNode[]): Map<string | null, KnowledgeNode[]> {

  const map = new Map<string | null, KnowledgeNode[]>();

  for (const node of nodes) {

    const list = map.get(node.parentId) ?? [];

    list.push(node);

    map.set(node.parentId, list);

  }

  for (const list of map.values()) {

    list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  }

  return map;

}





function nextDefaultChildName(parentId: string, nodes: KnowledgeNode[]): string {

  const siblingNames = new Set(

    nodes.filter((item) => item.parentId === parentId).map((item) => item.name),

  );

  let index = 1;

  while (siblingNames.has(`${DEFAULT_CHILD_PREFIX}${index}`)) {

    index += 1;

  }

  return `${DEFAULT_CHILD_PREFIX}${index}`;

}





function formatKnowledgeLoadError(bridgeUrl: string, error: unknown): string {

  const message = error instanceof Error ? error.message : String(error);

  if (message === "Failed to fetch" || message.includes("NetworkError")) {

    return `无法连接 Bridge（${bridgeUrl}）。请确认 Bridge 已启动（默认 http://127.0.0.1:4321），且本机页面未使用远程 Bridge 地址。`;

  }

  return message;

}





/** 知识库 wiki 树（全宽目录树 + 右键/长按菜单） */

export function KnowledgeWikiSection({ bridgeUrl, bridgeToken }: KnowledgeWikiSectionProps) {

  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);

  const [rootId, setRootId] = useState("root");

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set(["root"]));

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const [status, setStatus] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const uploadInputRef = useRef<HTMLInputElement>(null);

  const uploadTargetIdRef = useRef<string | null>(null);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const longPressOpenedRef = useRef(false);

  const childrenMap = useMemo(() => buildChildrenMap(nodes), [nodes]);

  const nodeById = useMemo(() => new Map(nodes.map((item) => [item.id, item])), [nodes]);





  const reload = useCallback(async (): Promise<void> => {

    setLoading(true);

    setError(null);

    try {

      const tree = await fetchKnowledgeTree(bridgeUrl, bridgeToken);

      setNodes(tree.nodes);

      setRootId(tree.rootId);

      setExpandedIds((previous) => {

        const next = new Set(previous);

        next.add(tree.rootId);

        return next;

      });

    } catch (loadError) {

      setError(formatKnowledgeLoadError(bridgeUrl, loadError));

    } finally {

      setLoading(false);

    }

  }, [bridgeToken, bridgeUrl]);





  useEffect(() => {

    void reload();

  }, [reload]);





  useEffect(() => {

    if (!contextMenu) {

      return;

    }

    const closeMenu = (): void => setContextMenu(null);

    window.addEventListener("click", closeMenu);

    window.addEventListener("scroll", closeMenu, true);

    window.addEventListener("resize", closeMenu);

    return () => {

      window.removeEventListener("click", closeMenu);

      window.removeEventListener("scroll", closeMenu, true);

      window.removeEventListener("resize", closeMenu);

    };

  }, [contextMenu]);





  const toggleExpanded = (nodeId: string): void => {

    setExpandedIds((previous) => {

      const next = new Set(previous);

      if (next.has(nodeId)) {

        next.delete(nodeId);

      } else {

        next.add(nodeId);

      }

      return next;

    });

  }





  const openContextMenu = (nodeId: string, clientX: number, clientY: number): void => {

    setContextMenu({ nodeId, x: clientX, y: clientY });

  }





  const handleContextMenu = (event: ReactMouseEvent, nodeId: string): void => {

    event.preventDefault();

    event.stopPropagation();

    openContextMenu(nodeId, event.clientX, event.clientY);

  }





  const clearLongPressTimer = (): void => {

    if (longPressTimerRef.current) {

      clearTimeout(longPressTimerRef.current);

      longPressTimerRef.current = null;

    }

  }





  const handleTouchStart = (event: ReactTouchEvent, nodeId: string): void => {

    longPressOpenedRef.current = false;

    clearLongPressTimer();

    const touch = event.touches[0];

    if (!touch) {

      return;

    }

    longPressTimerRef.current = setTimeout(() => {

      longPressOpenedRef.current = true;

      openContextMenu(nodeId, touch.clientX, touch.clientY);

    }, LONG_PRESS_MS);

  }





  const handleTouchEnd = (): void => {

    clearLongPressTimer();

  }





  const handleCreateChild = async (parentId: string): Promise<void> => {

    setContextMenu(null);

    setError(null);

    const name = nextDefaultChildName(parentId, nodes);

    try {

      const created = await createKnowledgeNode(bridgeUrl, parentId, name, bridgeToken);

      setStatus(`已创建子节点：${created.node.name}`);

      setExpandedIds((previous) => new Set(previous).add(parentId));

      await reload();

    } catch (createError) {

      const message = createError instanceof Error ? createError.message : String(createError);

      setError(message);

    }

  }





  const handleRename = async (nodeId: string): Promise<void> => {

    const node = nodeById.get(nodeId);

    if (!node) {

      return;

    }

    setContextMenu(null);

    const nextName = window.prompt("重命名节点", node.name)?.trim();

    if (!nextName || nextName === node.name) {

      return;

    }

    setError(null);

    try {

      const result = await renameKnowledgeNode(bridgeUrl, nodeId, nextName, bridgeToken);

      setStatus(`已重命名为：${result.node.name}`);

      await reload();

    } catch (renameError) {

      const message = renameError instanceof Error ? renameError.message : String(renameError);

      setError(message);

    }

  }





  const handleUploadPick = (nodeId: string): void => {

    setContextMenu(null);

    uploadTargetIdRef.current = nodeId;

    uploadInputRef.current?.click();

  }





  const handleUploadFile = async (file: File): Promise<void> => {

    const nodeId = uploadTargetIdRef.current;

    if (!nodeId) {

      return;

    }

    if (!file.name.toLowerCase().endsWith(".md")) {

      setError("仅支持 .md 文件");

      return;

    }

    setError(null);

    try {

      const result = await uploadKnowledgeMarkdown(bridgeUrl, nodeId, file, bridgeToken);

      setStatus(`已上传 ${file.name}（${result.bytes} 字节）`);

      await reload();

    } catch (uploadError) {

      const message = uploadError instanceof Error ? uploadError.message : String(uploadError);

      setError(message);

    }

  }





  const handleDelete = async (nodeId: string): Promise<void> => {

    const node = nodeById.get(nodeId);

    if (!node || nodeId === rootId) {

      setError("不能删除根节点");

      return;

    }

    setContextMenu(null);

    if (!window.confirm(`确定删除「${node.name}」及其子节点？`)) {

      return;

    }

    setError(null);

    try {

      await deleteKnowledgeNode(bridgeUrl, nodeId, bridgeToken);

      setStatus(`已删除：${node.name}`);

      await reload();

    } catch (deleteError) {

      const message = deleteError instanceof Error ? deleteError.message : String(deleteError);

      setError(message);

    }

  }





  const renderTree = (parentId: string | null, depth: number): ReactElement[] => {

    const children = childrenMap.get(parentId) ?? [];

    return children.flatMap((node) => {

      const childRows = expandedIds.has(node.id) ? renderTree(node.id, depth + 1) : [];

      const hasChildren = (childrenMap.get(node.id)?.length ?? 0) > 0;

      const expanded = expandedIds.has(node.id);

      return [

        <div

          key={node.id}

          className="knowledge-tree-row"

          style={{ paddingLeft: `${8 + depth * 16}px` }}

          onContextMenu={(event) => handleContextMenu(event, node.id)}

          onTouchStart={(event) => handleTouchStart(event, node.id)}

          onTouchEnd={handleTouchEnd}

          onTouchMove={handleTouchEnd}

          onTouchCancel={handleTouchEnd}

        >

          <button

            type="button"

            className="knowledge-tree-toggle"

            aria-expanded={hasChildren ? expanded : undefined}

            aria-label={expanded ? "折叠" : "展开"}

            disabled={!hasChildren}

            onClick={(event) => {

              event.stopPropagation();

              if (longPressOpenedRef.current) {

                longPressOpenedRef.current = false;

                return;

              }

              if (hasChildren) {

                toggleExpanded(node.id);

              }

            }}

          >

            {hasChildren ? (expanded ? "▾" : "▸") : "·"}

          </button>

          <button

            type="button"

            className="knowledge-tree-label"

            onClick={() => {

              if (longPressOpenedRef.current) {

                longPressOpenedRef.current = false;

                return;

              }

              if (hasChildren) {

                toggleExpanded(node.id);

              }

            }}

          >

            {node.name}

            {node.hasContent ? " · md" : ""}

          </button>

        </div>,

        ...childRows,

      ];

    });

  };





  const menuNode = contextMenu ? nodeById.get(contextMenu.nodeId) : null;





  return (

    <div className="knowledge-wiki-page">

      {loading && <p className="config-hint">加载中…</p>}

      {error && <p className="config-error">{error}</p>}

      {status && <p className="config-save-toast" role="status">{status}</p>}

      <div className="knowledge-tree-panel">

        <h3 className="knowledge-panel-title">目录树</h3>

        <p className="config-hint knowledge-tree-hint">左键展开/折叠；右键或长按节点打开操作菜单。</p>

        <div className="knowledge-tree" aria-label="知识库树">

          {!loading && renderTree(null, 0)}

        </div>

      </div>

      <input

        ref={uploadInputRef}

        type="file"

        accept=".md,text/markdown"

        className="knowledge-upload-input"

        onChange={(event) => {

          const file = event.target.files?.[0];

          if (file) {

            void handleUploadFile(file);

          }

          event.target.value = "";

        }}

      />

      {contextMenu && menuNode && (

        <div

          className="knowledge-context-menu"

          style={{ left: contextMenu.x, top: contextMenu.y }}

          role="menu"

          onClick={(event) => event.stopPropagation()}

        >

          <button type="button" role="menuitem" onClick={() => void handleCreateChild(menuNode.id)}>

            创建子节点

          </button>

          <button type="button" role="menuitem" onClick={() => handleUploadPick(menuNode.id)}>

            上传 .md

          </button>

          <button type="button" role="menuitem" onClick={() => void handleRename(menuNode.id)}>

            重命名

          </button>

          <button

            type="button"

            role="menuitem"

            className="knowledge-context-menu-danger"

            disabled={menuNode.id === rootId}

            onClick={() => void handleDelete(menuNode.id)}

          >

            删除节点

          </button>

        </div>

      )}

    </div>

  );

}


