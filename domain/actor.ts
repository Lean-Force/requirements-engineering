// エンティティ: Actor(アクター = 登場人物 / 利用者種別)
import { genId } from "./id";

export interface Actor {
  id: string;
  name: string;
}

export function createActor(name: string): Actor {
  return { id: genId("actor"), name };
}
