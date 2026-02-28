import { join } from 'path'
import { existsSync, readdirSync, statSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { app } from 'electron'
import { ConfigService } from './config'
import Database from 'better-sqlite3'
import { wcdbService } from './wcdbService'

export interface VideoInfo {
    videoUrl?: string       // 视频文件路径（用于 readFile）
    coverUrl?: string       // 封面 data URL
    thumbUrl?: string       // 缩略图 data URL
    exists: boolean
}

class VideoService {
    private configService: ConfigService

    constructor() {
        this.configService = new ConfigService()
    }

    private log(message: string, meta?: Record<string, unknown>): void {
        try {
            const timestamp = new Date().toISOString()
            const metaStr = meta ? ` ${JSON.stringify(meta)}` : ''
            const logDir = join(app.getPath('userData'), 'logs')
            if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
            appendFileSync(join(logDir, 'wcdb.log'), `[${timestamp}] [VideoService] ${message}${metaStr}\n`, 'utf8')
        } catch {}
    }

    /**
     * 获取数据库根目录
     */
    private getDbPath(): string {
        return this.configService.get('dbPath') || ''
    }

    /**
     * 获取当前用户的wxid
     */
    private getMyWxid(): string {
        return this.configService.get('myWxid') || ''
    }

    /**
     * 获取缓存目录（解密后的数据库存放位置）
     */
    private getCachePath(): string {
        return this.configService.getCacheBasePath()
    }

    /**
     * 清理 wxid 目录名（去掉后缀）
     */
    private cleanWxid(wxid: string): string {
        const trimmed = wxid.trim()
        if (!trimmed) return trimmed

        if (trimmed.toLowerCase().startsWith('wxid_')) {
            const match = trimmed.match(/^(wxid_[^_]+)/i)
            if (match) return match[1]
            return trimmed
        }

        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
        if (suffixMatch) return suffixMatch[1]

        return trimmed
    }

    /**
     * 从 video_hardlink_info_v4 表查询视频文件名
     * 优先使用 cachePath 中解密后的 hardlink.db（使用 better-sqlite3）
     * 如果失败，则尝试使用 wcdbService.execQuery 查询加密的 hardlink.db
     */
    private async queryVideoFileName(md5: string): Promise<string | undefined> {
        const cachePath = this.getCachePath()
        const dbPath = this.getDbPath()
        const wxid = this.getMyWxid()
        const cleanedWxid = this.cleanWxid(wxid)

        this.log('queryVideoFileName 开始', { md5, wxid, cleanedWxid, cachePath, dbPath })

        if (!wxid) {
            this.log('queryVideoFileName: wxid 为空')
            return undefined
        }

        // 方法1：优先在 cachePath 下查找解密后的 hardlink.db
        if (cachePath) {
            const cacheDbPaths = [
                join(cachePath, cleanedWxid, 'hardlink.db'),
                join(cachePath, wxid, 'hardlink.db'),
                join(cachePath, 'hardlink.db'),
                join(cachePath, 'databases', cleanedWxid, 'hardlink.db'),
                join(cachePath, 'databases', wxid, 'hardlink.db')
            ]

            for (const p of cacheDbPaths) {
                if (existsSync(p)) {
                    try {
                        this.log('尝试缓存 hardlink.db', { path: p })
                        const db = new Database(p, { readonly: true })
                        const row = db.prepare(`
                            SELECT file_name, md5 FROM video_hardlink_info_v4
                            WHERE md5 = ?
                            LIMIT 1
                        `).get(md5) as { file_name: string; md5: string } | undefined
                        db.close()

                        if (row?.file_name) {
                            const realMd5 = row.file_name.replace(/\.[^.]+$/, '')
                            this.log('缓存 hardlink.db 命中', { file_name: row.file_name, realMd5 })
                            return realMd5
                        }
                        this.log('缓存 hardlink.db 未命中', { path: p })
                    } catch (e) {
                        this.log('缓存 hardlink.db 查询失败', { path: p, error: String(e) })
                    }
                }
            }
        }

        // 方法2：使用 wcdbService.execQuery 查询加密的 hardlink.db
        if (dbPath) {
            const dbPathLower = dbPath.toLowerCase()
            const wxidLower = wxid.toLowerCase()
            const cleanedWxidLower = cleanedWxid.toLowerCase()
            const dbPathContainsWxid = dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxidLower)

            const encryptedDbPaths: string[] = []
            if (dbPathContainsWxid) {
                encryptedDbPaths.push(join(dbPath, 'db_storage', 'hardlink', 'hardlink.db'))
            } else {
                encryptedDbPaths.push(join(dbPath, wxid, 'db_storage', 'hardlink', 'hardlink.db'))
                encryptedDbPaths.push(join(dbPath, cleanedWxid, 'db_storage', 'hardlink', 'hardlink.db'))
            }

            for (const p of encryptedDbPaths) {
                if (existsSync(p)) {
                    try {
                        this.log('尝试加密 hardlink.db', { path: p })
                        const escapedMd5 = md5.replace(/'/g, "''")
                        const sql = `SELECT file_name FROM video_hardlink_info_v4 WHERE md5 = '${escapedMd5}' LIMIT 1`
                        const result = await wcdbService.execQuery('media', p, sql)

                        if (result.success && result.rows && result.rows.length > 0) {
                            const row = result.rows[0]
                            if (row?.file_name) {
                                const realMd5 = String(row.file_name).replace(/\.[^.]+$/, '')
                                this.log('加密 hardlink.db 命中', { file_name: row.file_name, realMd5 })
                                return realMd5
                            }
                        }
                        this.log('加密 hardlink.db 未命中', { path: p, result: JSON.stringify(result).slice(0, 200) })
                    } catch (e) {
                        this.log('加密 hardlink.db 查询失败', { path: p, error: String(e) })
                    }
                } else {
                    this.log('加密 hardlink.db 不存在', { path: p })
                }
            }
        }
        this.log('queryVideoFileName: 所有方法均未找到', { md5 })
        return undefined
    }

    /**
     * 将文件转换为 data URL
     */
    private fileToDataUrl(filePath: string, mimeType: string): string | undefined {
        try {
            if (!existsSync(filePath)) return undefined
            const buffer = readFileSync(filePath)
            return `data:${mimeType};base64,${buffer.toString('base64')}`
        } catch {
            return undefined
        }
    }

    /**
     * 根据视频MD5获取视频文件信息
     * 视频存放在: {数据库根目录}/{用户wxid}/msg/video/{年月}/
     * 文件命名: {md5}.mp4, {md5}.jpg, {md5}_thumb.jpg
     */
    async getVideoInfo(videoMd5: string): Promise<VideoInfo> {
        const dbPath = this.getDbPath()
        const wxid = this.getMyWxid()

        this.log('getVideoInfo 开始', { videoMd5, dbPath, wxid })

        if (!dbPath || !wxid || !videoMd5) {
            this.log('getVideoInfo: 参数缺失', { dbPath: !!dbPath, wxid: !!wxid, videoMd5: !!videoMd5 })
            return { exists: false }
        }

        // 先尝试从数据库查询真正的视频文件名
        const realVideoMd5 = await this.queryVideoFileName(videoMd5) || videoMd5
        this.log('realVideoMd5', { input: videoMd5, resolved: realVideoMd5, changed: realVideoMd5 !== videoMd5 })

        // 检查 dbPath 是否已经包含 wxid，避免重复拼接
        const dbPathLower = dbPath.toLowerCase()
        const wxidLower = wxid.toLowerCase()
        const cleanedWxid = this.cleanWxid(wxid)

        let videoBaseDir: string
        if (dbPathLower.includes(wxidLower) || dbPathLower.includes(cleanedWxid.toLowerCase())) {
            videoBaseDir = join(dbPath, 'msg', 'video')
        } else {
            videoBaseDir = join(dbPath, wxid, 'msg', 'video')
        }

        this.log('videoBaseDir', { videoBaseDir, exists: existsSync(videoBaseDir) })

        if (!existsSync(videoBaseDir)) {
            this.log('getVideoInfo: videoBaseDir 不存在')
            return { exists: false }
        }

        // 遍历年月目录查找视频文件
        try {
            const allDirs = readdirSync(videoBaseDir)
            const yearMonthDirs = allDirs
                .filter(dir => {
                    const dirPath = join(videoBaseDir, dir)
                    return statSync(dirPath).isDirectory()
                })
                .sort((a, b) => b.localeCompare(a))

            this.log('扫描目录', { dirs: yearMonthDirs })

            for (const yearMonth of yearMonthDirs) {
                const dirPath = join(videoBaseDir, yearMonth)
                const videoPath = join(dirPath, `${realVideoMd5}.mp4`)

                if (existsSync(videoPath)) {
                    this.log('找到视频', { videoPath })
                    const coverPath = join(dirPath, `${realVideoMd5}.jpg`)
                    const thumbPath = join(dirPath, `${realVideoMd5}_thumb.jpg`)
                    return {
                        videoUrl: videoPath,
                        coverUrl: this.fileToDataUrl(coverPath, 'image/jpeg'),
                        thumbUrl: this.fileToDataUrl(thumbPath, 'image/jpeg'),
                        exists: true
                    }
                }
            }

            // 没找到，列出第一个目录里的文件帮助排查
            if (yearMonthDirs.length > 0) {
                const firstDir = join(videoBaseDir, yearMonthDirs[0])
                const files = readdirSync(firstDir).filter(f => f.endsWith('.mp4')).slice(0, 5)
                this.log('未找到视频，最新目录样本', { dir: yearMonthDirs[0], sampleFiles: files, lookingFor: `${realVideoMd5}.mp4` })
            }
        } catch (e) {
            this.log('getVideoInfo 遍历出错', { error: String(e) })
        }

        this.log('getVideoInfo: 未找到视频', { videoMd5, realVideoMd5 })
        return { exists: false }
    }

    /**
     * 根据消息内容解析视频MD5
     */
    parseVideoMd5(content: string): string | undefined {

        // 打印前500字符看看 XML 结构

        if (!content) return undefined

        try {
            // 提取所有可能的 md5 值进行日志
            const allMd5s: string[] = []
            const md5Regex = /(?:md5|rawmd5|newmd5|originsourcemd5)\s*=\s*['"]([a-fA-F0-9]+)['"]/gi
            let match
            while ((match = md5Regex.exec(content)) !== null) {
                allMd5s.push(`${match[0]}`)
            }

            // 提取 md5（用于查询 hardlink.db）
            // 注意：不是 rawmd5，rawmd5 是另一个值
            // 格式: md5="xxx" 或 <md5>xxx</md5>

            // 尝试从videomsg标签中提取md5
            const videoMsgMatch = /<videomsg[^>]*\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
            if (videoMsgMatch) {
                return videoMsgMatch[1].toLowerCase()
            }

            const attrMatch = /\smd5\s*=\s*['"]([a-fA-F0-9]+)['"]/i.exec(content)
            if (attrMatch) {
                console.log('[VideoService] Found MD5 via attribute:', attrMatch[1])
                return attrMatch[1].toLowerCase()
            }

            const md5Match = /<md5>([a-fA-F0-9]+)<\/md5>/i.exec(content)
            if (md5Match) {
                return md5Match[1].toLowerCase()
            }
        } catch (e) {
            console.error('[VideoService] 解析视频MD5失败:', e)
        }

        return undefined
    }
}

export const videoService = new VideoService()
