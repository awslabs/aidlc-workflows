import { AidlcService } from '../services/aidlc-service';
import { FileService } from '../services/file-service';

// Mock FileService
jest.mock('../services/file-service');

describe('AidlcService', () => {
  let aidlcService: AidlcService;
  let mockFileService: jest.Mocked<FileService>;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
    
    // Create mock FileService
    mockFileService = {
      exists: jest.fn(),
      readFile: jest.fn(),
      writeFile: jest.fn(),
      copy: jest.fn(),
      ensureDir: jest.fn(),
      remove: jest.fn(),
      readDir: jest.fn(),
      stat: jest.fn(),
      isDirectory: jest.fn(),
      isFile: jest.fn(),
      findFiles: jest.fn(),
      getFileSize: jest.fn(),
      getModifiedTime: jest.fn(),
      appendFile: jest.fn(),
      createSymlink: jest.fn(),
      move: jest.fn(),
      getAbsolutePath: jest.fn(),
      getRelativePath: jest.fn(),
      parsePath: jest.fn(),
      joinPath: jest.fn()
    } as jest.Mocked<FileService>;

    // Mock the FileService constructor
    (FileService as jest.MockedClass<typeof FileService>).mockImplementation(() => mockFileService);
    
    aidlcService = new AidlcService();
  });

  describe('checkExistingInstallation', () => {
    it('should detect Kiro installation', async () => {
      mockFileService.exists
        .mockResolvedValueOnce(true)  // Kiro rules exist
        .mockResolvedValueOnce(false); // Amazon Q rules don't exist

      const result = await aidlcService.checkExistingInstallation();

      expect(result.hasKiro).toBe(true);
      expect(result.hasAmazonQ).toBe(false);
      expect(result.kiroPath).toBe('.kiro/steering/aws-aidlc-rules');
    });

    it('should detect Amazon Q installation', async () => {
      mockFileService.exists
        .mockResolvedValueOnce(false) // Kiro rules don't exist
        .mockResolvedValueOnce(true); // Amazon Q rules exist

      const result = await aidlcService.checkExistingInstallation();

      expect(result.hasKiro).toBe(false);
      expect(result.hasAmazonQ).toBe(true);
      expect(result.amazonqPath).toBe('.amazonq/rules/aws-aidlc-rules');
    });

    it('should detect no installation', async () => {
      mockFileService.exists.mockResolvedValue(false);

      const result = await aidlcService.checkExistingInstallation();

      expect(result.hasKiro).toBe(false);
      expect(result.hasAmazonQ).toBe(false);
      expect(result.kiroPath).toBeUndefined();
      expect(result.amazonqPath).toBeUndefined();
    });
  });

  describe('parseWorkflowState', () => {
    it('should parse workflow state correctly', () => {
      const stateContent = `
# AI-DLC Workflow State

## Phases
- ✅ Inception Phase
- 🔄 Construction Phase  
- ⏳ Operations Phase
- ⏭️ Skipped Phase
      `;

      const phases = aidlcService.parseWorkflowState(stateContent);

      expect(phases).toHaveLength(4);
      expect(phases[0]).toEqual({
        name: 'Inception Phase',
        completed: true,
        inProgress: false,
        skipped: false
      });
      expect(phases[1]).toEqual({
        name: 'Construction Phase',
        completed: false,
        inProgress: true,
        skipped: false
      });
      expect(phases[2]).toEqual({
        name: 'Operations Phase',
        completed: false,
        inProgress: false,
        skipped: false
      });
      expect(phases[3]).toEqual({
        name: 'Skipped Phase',
        completed: false,
        inProgress: false,
        skipped: true
      });
    });
  });

  describe('getRecommendations', () => {
    it('should recommend tools when none are available', () => {
      const environment = {
        nodeVersion: 'v18.0.0',
        platform: 'darwin',
        hasKiroCli: false,
        hasAmazonQ: false,
        hasClaudeCode: false,
        hasCursor: false,
        hasWindsurf: false,
        hasAntigravity: false,
        hasGitHubCopilot: false,
        hasCodex: false,
        hasGeminiCLI: false,
        hasQoder: false,
        hasRoo: false,
        hasCodeBuddy: false,
        isGitRepo: true
      };

      const recommendations = aidlcService.getRecommendations(environment);

      expect(recommendations).toContain('Install at least one AI coding assistant (Kiro CLI, Amazon Q, Claude Code, Cursor, Windsurf, Antigravity, GitHub Copilot, Codex, Gemini CLI, Qoder, Roo, or CodeBuddy)');
    });

    it('should recommend Git initialization', () => {
      const environment = {
        nodeVersion: 'v18.0.0',
        platform: 'darwin',
        hasKiroCli: true,
        hasAmazonQ: false,
        hasClaudeCode: false,
        hasCursor: false,
        hasWindsurf: false,
        hasAntigravity: false,
        hasGitHubCopilot: false,
        hasCodex: false,
        hasGeminiCLI: false,
        hasQoder: false,
        hasRoo: false,
        hasCodeBuddy: false,
        isGitRepo: false
      };

      const recommendations = aidlcService.getRecommendations(environment);

      expect(recommendations).toContain('Initialize Git repository for better project tracking');
    });

    it('should recommend Node.js update', () => {
      const environment = {
        nodeVersion: 'v14.0.0',
        platform: 'darwin',
        hasKiroCli: true,
        hasAmazonQ: false,
        hasClaudeCode: false,
        hasCursor: false,
        hasWindsurf: false,
        hasAntigravity: false,
        hasGitHubCopilot: false,
        hasCodex: false,
        hasGeminiCLI: false,
        hasQoder: false,
        hasRoo: false,
        hasCodeBuddy: false,
        isGitRepo: true
      };

      const recommendations = aidlcService.getRecommendations(environment);

      expect(recommendations).toContain('Update Node.js to version 16 or higher');
    });
  });
});