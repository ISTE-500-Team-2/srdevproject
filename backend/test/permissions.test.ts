import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response } from 'express';
import { authorize, requireAdmin, requireOwnershipOrAdmin } from '../src/auth.js';
const member = {id: 7, roles: ['member']};
const rule = {roleName: 'member', permissionName: 'read', resourceName: 'all_tables', scopeType: 'personal', isAllowed: true};
test('personal wildcard grants require trusted matching owner and deny missing/foreign owners', () => {
  for (const ownerId of [null, 0, 8]) assert.equal(authorize({user: member, rules:[rule], resourceName:'waiver', ownerId}), false);
  assert.equal(authorize({user: member, rules:[rule], resourceName:'waiver', ownerId:7}), true);
});
test('unknown permissions and missing scopes fail closed; explicit denies override grants', () => {
  assert.equal(authorize({user:member,rules:[{...rule,permissionName:undefined}],resourceName:'waiver',ownerId:7}),false);
  assert.equal(authorize({user:member,rules:[{...rule,scopeType:undefined}],resourceName:'waiver',ownerId:7}),false);
  assert.equal(authorize({user:member,rules:[rule,{...rule,isAllowed:false}],resourceName:'waiver',ownerId:7}),false);
});
test('staff scoped writes cannot grant role management even through wildcard permission', () => {
  const user={id:3,roles:['staff']};
  const grant={...rule,roleName:'staff',permissionName:'update',scopeType:'global'};
  assert.equal(authorize({user,rules:[grant],resourceName:'payment',action:'update'}),true);
  for(const resourceName of ['role','permission','user_role','role_permission'])
    assert.equal(authorize({user,rules:[grant],resourceName,action:'update'}),false);
});
function probe(middleware: typeof requireAdmin, user: typeof member | null, owner?:number) {
  let allowed=false,status=200;
  const res={locals:{auth:{user},resourceOwnerId:owner},status(n:number){status=n;return this},json(){return this}};
  middleware({body:{ownerId:7,resourceName:'role',action:'update'}} as Request,res as unknown as Response,()=>{allowed=true});
  return {allowed,status};
}
test('ownership middleware uses server-resolved owner and authenticated id, ignoring body claims', () => {
  assert.deepEqual(probe(requireOwnershipOrAdmin,member,7),{allowed:true,status:200});
  for (const owner of [undefined,8]) assert.equal(probe(requireOwnershipOrAdmin,member,owner).status,403);
  assert.equal(probe(requireOwnershipOrAdmin,null,7).status,403);
});
test('real administrators may manage RBAC objects but staff cannot', () => {
  assert.equal(probe(requireAdmin,{id:1,roles:['admin']}).allowed,true);
  assert.equal(probe(requireAdmin,{id:2,roles:['staff']}).status,403);
});
