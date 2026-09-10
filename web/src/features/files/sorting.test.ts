import { describe, expect, it } from 'vitest';
import { sortEntries } from './MeshFiles';
describe('文件排序', () => {
 const files = [{ name:'文件10',type:3,size:1,modified:30 }, { name:'文件2',type:3,size:9,modified:10 }, {name:'目录',type:2,size:0,modified:0}];
 it('名称自然排序并保留目录优先，不改变源列表',()=>{expect(sortEntries(files,'name').map(f=>f.name)).toEqual(['目录','文件2','文件10']);expect(files[0].name).toBe('文件10');});
 it('时间和大小支持升降序',()=>{expect(sortEntries(files,'modified').map(f=>f.name)).toEqual(['目录','文件2','文件10']);expect(sortEntries(files,'size').map(f=>f.name)).toEqual(['目录','文件10','文件2']);expect(sortEntries(files,'size',true).map(f=>f.name)).toEqual(['目录','文件2','文件10']);});
});
