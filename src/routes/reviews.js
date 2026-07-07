// src/routes/reviews.js — Featured reviews.
import { Router } from 'express'
import * as repo from '../db/repositories/reviews.repo.js'
import { asyncHandler } from '../middleware/_asyncHandler.js'

export const reviews = Router()

reviews.get('/', asyncHandler(async (_req, res) => {
  res.json(await repo.listFeatured())
}))