import * as fs from 'fs-extra';
import * as path from 'path';

export class FileService {
  
  /**
   * 检查文件或目录是否存在
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * 读取文件内容
   */
  async readFile(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf-8');
  }
  
  /**
   * 写入文件内容
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, content, 'utf-8');
  }
  
  /**
   * 复制文件或目录
   */
  async copy(source: string, destination: string): Promise<void> {
    await fs.copy(source, destination);
  }
  
  /**
   * 创建目录
   */
  async ensureDir(dirPath: string): Promise<void> {
    await fs.ensureDir(dirPath);
  }
  
  /**
   * 删除文件或目录
   */
  async remove(filePath: string): Promise<void> {
    await fs.remove(filePath);
  }
  
  /**
   * 获取目录内容
   */
  async readDir(dirPath: string): Promise<string[]> {
    return await fs.readdir(dirPath);
  }
  
  /**
   * 获取文件统计信息
   */
  async stat(filePath: string): Promise<fs.Stats> {
    return await fs.stat(filePath);
  }
  
  /**
   * 检查是否为目录
   */
  async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stats = await this.stat(filePath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }
  
  /**
   * 检查是否为文件
   */
  async isFile(filePath: string): Promise<boolean> {
    try {
      const stats = await this.stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }
  
  /**
   * 递归查找文件
   */
  async findFiles(dirPath: string, pattern: RegExp): Promise<string[]> {
    const files: string[] = [];
    
    if (!await this.exists(dirPath)) {
      return files;
    }
    
    const items = await this.readDir(dirPath);
    
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      
      if (await this.isDirectory(itemPath)) {
        const subFiles = await this.findFiles(itemPath, pattern);
        files.push(...subFiles);
      } else if (pattern.test(item)) {
        files.push(itemPath);
      }
    }
    
    return files;
  }
  
  /**
   * 获取文件大小
   */
  async getFileSize(filePath: string): Promise<number> {
    const stats = await this.stat(filePath);
    return stats.size;
  }
  
  /**
   * 获取文件修改时间
   */
  async getModifiedTime(filePath: string): Promise<Date> {
    const stats = await this.stat(filePath);
    return stats.mtime;
  }
  
  /**
   * 追加内容到文件
   */
  async appendFile(filePath: string, content: string): Promise<void> {
    await fs.appendFile(filePath, content, 'utf-8');
  }
  
  /**
   * 创建符号链接
   */
  async createSymlink(target: string, linkPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(linkPath));
    await fs.symlink(target, linkPath);
  }
  
  /**
   * 移动文件或目录
   */
  async move(source: string, destination: string): Promise<void> {
    await fs.move(source, destination);
  }
  
  /**
   * 获取绝对路径
   */
  getAbsolutePath(filePath: string): string {
    return path.resolve(filePath);
  }
  
  /**
   * 获取相对路径
   */
  getRelativePath(from: string, to: string): string {
    return path.relative(from, to);
  }
  
  /**
   * 解析路径
   */
  parsePath(filePath: string): path.ParsedPath {
    return path.parse(filePath);
  }
  
  /**
   * 连接路径
   */
  joinPath(...paths: string[]): string {
    return path.join(...paths);
  }
}