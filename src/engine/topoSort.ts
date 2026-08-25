// ============================================================================
//  TOPOLOGICAL SORT
//  Given nodes and directed edges, return an order where every node comes
//  AFTER all nodes that point into it. That's how the engine knows a step is
//  safe to run: all its inputs are ready.
//
//  Algorithm = Kahn's algorithm (BFS on in-degree):
//    1. Count incoming edges (in-degree) for each node.
//    2. Start with nodes that have in-degree 0 (nothing feeds them).
//    3. Remove a node, decrement its neighbours' in-degree; any that hit 0
//       become ready. Repeat.
//    4. If we can't place every node, there's a cycle -> we reject it.
//
//  This is the "CS fundamentals + system design" the feedback asked for, and
//  it's why the pipeline is a real graph, not a hard-coded sequence.
// ============================================================================

export interface GraphNode { id: string; }
export interface GraphEdge { from_node_id: string; to_node_id: string; }

export function topoSort(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }
  for (const e of edges) {
    adjacency.get(e.from_node_id)!.push(e.to_node_id);
    inDegree.set(e.to_node_id, (inDegree.get(e.to_node_id) ?? 0) + 1);
  }

  // Queue of nodes with no remaining dependencies.
  const ready: string[] = [];
  for (const [nodeId, deg] of inDegree) if (deg === 0) ready.push(nodeId);

  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const next of adjacency.get(current)!) {
      inDegree.set(next, inDegree.get(next)! - 1);
      if (inDegree.get(next) === 0) ready.push(next);
    }
  }

  if (order.length !== nodes.length) {
    throw new Error('Workflow graph has a cycle — cannot determine run order.');
  }
  return order;
}
