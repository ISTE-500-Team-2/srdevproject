import type {Request,Response} from 'express';
import type {Pool} from 'pg';
import {AppError,positiveId} from '../domain.js';
import {authState} from '../middleware/auth.js';
import {instant,reasonField} from '../staffDomain.js';
import {WaiverRecordsService} from '../services/WaiverRecordsService.js';
export class WaiverRecordsController {
  private service:WaiverRecordsService;
  constructor(pool:Pool){this.service=new WaiverRecordsService(pool);}
  mine=async(_req:Request,res:Response)=>{const id=authState(res).user.id;res.json({data:await this.service.list(id,id)});};
  ownCopy=async(req:Request,res:Response)=>{const id=authState(res).user.id;res.json({data:await this.service.copy(id,id,positiveId(req.params.id))});};
  member=async(req:Request,res:Response)=>{res.json({data:await this.service.list(authState(res).user.id,positiveId(req.params.id))});};
  memberCopy=async(req:Request,res:Response)=>{res.json({data:await this.service.copy(authState(res).user.id,positiveId(req.params.id),positiveId(req.params.waiverId))});};
  expiry=async(req:Request,res:Response)=>{
    if(!Object.hasOwn(req.body??{},'expiresAt') || !Object.hasOwn(req.body??{},'expectedExpiry'))throw new AppError(400,'INVALID_INPUT','Provide expiration and the previously shown expiration, or null.');
    const expiresAt=req.body.expiresAt===null?null:instant(req.body.expiresAt);
    const expectedExpiry=req.body.expectedExpiry===null?null:instant(req.body.expectedExpiry);
    res.json({data:await this.service.expiry(authState(res).user.id,positiveId(req.params.id),positiveId(req.params.waiverId),expiresAt,expectedExpiry,reasonField(req.body.reason))});
  };
}
