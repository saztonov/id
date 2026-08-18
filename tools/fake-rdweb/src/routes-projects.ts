/**
 * Проекты и дерево — по `routes/projects.py` и `routes/projects_nodes.py`.
 *
 * Членства и ролей у двойника нет: единственная служебная учётка везде «editor».
 * Проверяются только те инварианты, на которых спотыкается адаптер — принадлежность
 * родителя тому же проекту и запрет создавать документ узлом дерева.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { conflict, notFound, unprocessable } from './errors.js';
import { parseBody, requireUser } from './routes-auth.js';
import {
  PORTAL_PROJECT_ID,
  PORTAL_PROJECT_NAME,
  type DocumentRecord,
  type FakeState,
  type NodeRecord,
  type NodeTypeName,
  type TreeItemOut,
} from './state.js';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

const nodeTypes = [
  'folder',
  'client',
  'project',
  'section',
  'stage',
  'task',
  'document',
] as const satisfies readonly NodeTypeName[];

const createNodeSchema = z.object({
  project_id: z.string().regex(idPattern),
  parent_id: z.string().regex(idPattern).nullish(),
  node_type: z.enum(nodeTypes),
  name: z.string().min(1).max(255),
  code: z.string().max(255).nullish(),
  sort_order: z.number().int().nullish(),
  attributes: z.unknown().nullish(),
});

/** `_projects_helpers._node_to_item`. */
export function nodeToItem(node: NodeRecord): TreeItemOut {
  return {
    kind: 'node',
    node_id: node.nodeId,
    project_id: node.projectId,
    parent_id: node.parentId,
    node_type: node.nodeType,
    name: node.name,
    code: node.code,
    path: node.path,
    depth: node.depth,
    sort_order: node.sortOrder,
    status: null,
    attributes: node.attributes ?? null,
    document_id: null,
    document_status: null,
    page_count: null,
    project_version: null,
    counters: null,
    verification: null,
    recognizing: false,
    is_done: false,
    done_at: null,
    done_by_email: null,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
  };
}

/** `_projects_helpers._document_to_item`: у документа `node_id` = `document_id`. */
export function documentToItem(state: FakeState, document: DocumentRecord): TreeItemOut {
  return {
    kind: 'document',
    node_id: document.documentId,
    project_id: document.projectId,
    parent_id: document.nodeId,
    node_type: 'document',
    name: document.fileName,
    code: null,
    path: null,
    depth: null,
    sort_order: null,
    status: null,
    attributes: null,
    document_id: document.documentId,
    document_status: document.status,
    page_count: document.pageCount,
    project_version: document.projectVersion,
    counters: state.counters(document.documentId),
    verification: null,
    recognizing: false,
    is_done: false,
    done_at: null,
    done_by_email: null,
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

export function registerProjectRoutes(app: FastifyInstance, state: FakeState): void {
  app.get('/api/projects', async (request) => {
    requireUser(state, request);
    return [
      {
        project_id: PORTAL_PROJECT_ID,
        role: 'editor',
        name: PORTAL_PROJECT_NAME,
        status: 'active',
        is_done: false,
        done_at: null,
        done_by_email: null,
        recognizing: false,
      },
    ];
  });

  app.get('/api/projects/tree', async (request) => {
    requireUser(state, request);
    const query = request.query as Record<string, string | undefined>;
    const projectId = query['project_id'];
    if (projectId === undefined || !idPattern.test(projectId)) {
      throw unprocessable('project_id: обязательный параметр');
    }
    const parentId = query['parent_id'] ?? null;
    const nodes = [...state.nodes.values()]
      .filter((n) => n.projectId === projectId && (n.parentId ?? null) === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.nodeId.localeCompare(b.nodeId));
    const items: TreeItemOut[] = nodes.map(nodeToItem);
    // Документы висят на конкретном узле, поэтому в корне проекта их не перечисляем —
    // ровно как ветка `parent_id is not None` в оригинале.
    if (parentId !== null) {
      for (const document of state.documents.values()) {
        if (document.projectId === projectId && document.nodeId === parentId) {
          items.push(documentToItem(state, document));
        }
      }
    }
    return items;
  });

  app.post('/api/projects/nodes', async (request, reply) => {
    requireUser(state, request);
    const body = parseBody(createNodeSchema, request.body);
    if (body.node_type === 'document') {
      throw unprocessable('Документы создаются через upload, а не как узел дерева');
    }
    const parentId = body.parent_id ?? null;
    let parent: NodeRecord | undefined;
    if (parentId !== null) {
      parent = state.nodes.get(parentId);
      if (parent === undefined) {
        throw notFound('Узел не найден');
      }
      if (parent.projectId !== body.project_id) {
        throw conflict('Родительский узел принадлежит другому проекту');
      }
      const hasDocuments = [...state.documents.values()].some((d) => d.nodeId === parentId);
      if (hasDocuments) {
        throw conflict(
          'Нельзя создать подпапку в папке с файлами (файлы — только в листовой папке)',
        );
      }
    }
    const nodeId = state.newId('node');
    const path = parent === undefined ? nodeId : `${parent.path}/${nodeId}`;
    const depth = parent === undefined ? 0 : parent.depth + 1;
    const siblings = [...state.nodes.values()].filter(
      (n) => n.projectId === body.project_id && (n.parentId ?? null) === parentId,
    );
    const now = state.now();
    const node: NodeRecord = {
      nodeId,
      projectId: body.project_id,
      parentId,
      nodeType: body.node_type,
      name: body.name,
      code: body.code ?? null,
      path,
      depth,
      sortOrder: body.sort_order ?? siblings.length,
      attributes: body.attributes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    state.nodes.set(nodeId, node);
    return reply.code(201).send(nodeToItem(node));
  });
}
