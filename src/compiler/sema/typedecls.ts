/* ============================================================
   TYPE DECLARATIONS — struct, enum and typedef registration
   (global or local). Struct fields may use earlier structs,
   arrays sized by constants, and default member initialisers.
   ============================================================ */

import type { EnumDecl, StructDecl, TypedefDecl } from '../ast'
import { T } from '../ctypes'
import type { Sema, StructInfo } from './context'
import { constIntOf } from './exprs'

export function declareStruct(cx: Sema, d: StructDecl): void {
  if (cx.structByName.has(d.name)) {
    cx.error(d.nameSpan, `Redefinition of 'struct ${d.name}'`)
    return
  }
  const info: StructInfo = { id: cx.structs.length, name: d.name, fields: [], span: d.span }
  cx.structs.push(info)
  cx.structByName.set(d.name, info)
  for (const f of d.fields) {
    if (f.spec.isStatic) cx.error(f.span, 'Static struct members are not supported')
    for (const decl of f.decls) {
      if (decl.isRef) cx.error(decl.nameSpan, 'Reference fields are not supported in structs')
      const ty = cx.resolveType(f.spec, decl.pointer, decl.dims, false)
      if (ty.t === 'struct' && ty.id === info.id) cx.error(decl.nameSpan, `Struct '${d.name}' cannot contain itself`)
      if (ty.t === 'prim' && ty.p === 'void') cx.error(decl.nameSpan, `Field '${decl.name}' cannot have type 'void'`)
      if (f.spec.inferred) cx.error(f.spec.span, 'Struct fields need an explicit type')
      if (info.fields.some((x) => x.name === decl.name)) cx.error(decl.nameSpan, `Duplicate field '${decl.name}' in struct '${d.name}'`)
      info.fields.push({ name: decl.name, ty, init: decl.init })
    }
  }
  if (info.fields.length === 0) cx.warning(d.nameSpan, `Struct '${d.name}' has no fields`)
}

export function declareEnum(cx: Sema, d: EnumDecl): void {
  const members = new Map<string, number>()
  let next = 0
  for (const m of d.members) {
    if (m.value) {
      const v = constIntOf(cx, m.value)
      if (v === null) cx.error(m.value.span, `Enum value for '${m.name}' must be an integer constant`)
      else next = v
    }
    members.set(m.name, next)
    if (!d.isClass) cx.declare({ kind: 'enumConst', name: m.name, value: next, span: m.span }, m.span)
    next = (next + 1) | 0
  }
  if (d.name) {
    if (cx.enums.has(d.name)) cx.error(d.span, `Redefinition of enum '${d.name}'`)
    cx.enums.set(d.name, { isClass: d.isClass, members })
  }
}

export function declareTypedef(cx: Sema, d: TypedefDecl): void {
  if (d.spec.structDef && !cx.structByName.has(d.spec.structDef.name)) declareStruct(cx, d.spec.structDef)
  if (d.spec.enumDef) declareEnum(cx, d.spec.enumDef)
  let base = d.spec.enumDef ? T.int : T.error
  if (d.spec.structDef) {
    const st = cx.structByName.get(d.spec.structDef.name)
    // `typedef struct { ... } Point;` — the anonymous struct takes the typedef name
    if (st && st.name.startsWith('__anon_struct')) st.name = d.name
    if (st) base = { t: 'struct', id: st.id, name: st.name }
  } else if (!d.spec.enumDef) {
    base = cx.resolveType(d.spec, 0, [], false)
  }
  const ty = cx.applyDims(base, d.dims, false, d.span)
  if (cx.typedefs.has(d.name)) cx.error(d.nameSpan, `Redefinition of typedef '${d.name}'`)
  cx.typedefs.set(d.name, ty)
  if (ty.t === 'struct' && !cx.structByName.has(d.name)) cx.structByName.set(d.name, cx.structs[ty.id])
}
