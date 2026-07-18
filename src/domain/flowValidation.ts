import type { FlowDefinition } from './flowEngine';

/**
 * Validação estrutural de um fluxo (P4.5): avisos exibidos ANTES de
 * salvar/ativar. Não bloqueia o save (rascunho vale), mas nada é silencioso.
 */
export function validateFlowDefinition(def: FlowDefinition): string[] {
  const warnings: string[] = [];
  const nodes = def.nodes ?? [];
  const edges = def.edges ?? [];
  const ids = new Set(nodes.map((n) => n.id));

  // 1) Sem nó Início.
  const starts = nodes.filter((n) => n.type === 'start');
  if (starts.length === 0) warnings.push('Fluxo sem nó Início — nunca será disparado.');
  if (starts.length > 1) warnings.push('Fluxo com mais de um nó Início.');

  // 2) Arestas soltas (apontando para nó inexistente).
  for (const e of edges) {
    if (!ids.has(e.source)) warnings.push(`Aresta solta: origem "${e.source}" não existe.`);
    if (!ids.has(e.target)) warnings.push(`Aresta solta: destino "${e.target}" não existe.`);
  }

  // 3) Nós órfãos (inalcançáveis a partir do Início).
  if (starts.length > 0) {
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      if (!adj.has(e.source)) adj.set(e.source, []);
      adj.get(e.source)!.push(e.target);
    }
    const reachable = new Set<string>();
    const queue = starts.map((s) => s.id);
    while (queue.length) {
      const cur = queue.pop()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      for (const next of adj.get(cur) ?? []) queue.push(next);
    }
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        warnings.push(`Nó órfão: "${n.id}" (${n.type}) nunca é alcançado a partir do Início.`);
      }
    }
  }

  return warnings;
}
