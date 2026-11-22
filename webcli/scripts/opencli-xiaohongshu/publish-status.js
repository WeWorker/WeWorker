import { cli } from './registry.js';
import { getPublishStatus } from './publish-support.js';
cli({ name: 'publish-status', access: 'read', domain: 'creator.xiaohongshu.com',
  description: '查询最近一页创作者笔记中的指定笔记，返回图片数与审核状态；不存在不代表删除',
  args: [{ name: 'note-id', required: true, help: '已提交笔记的 24 位 ID' }],
  func: getPublishStatus });
