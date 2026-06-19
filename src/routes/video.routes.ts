import { Router } from "express";
import { getVideoDetails, analyzeVideo } from "../controllers/video.controller";

const route = Router();

route.post('/detail', getVideoDetails);
route.post('/analyze', analyzeVideo);

export default route;
