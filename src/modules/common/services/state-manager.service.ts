import { Injectable, Logger } from '@nestjs/common';
import { SeederState } from '../enums/state.enum';

@Injectable()
export class StateManagerService {
  private readonly logger = new Logger(StateManagerService.name);
  private currentState: SeederState = SeederState.REDIS_MODE;

  getState(): SeederState {
    return this.currentState;
  }

  setState(state: SeederState): void {
    const previousState = this.currentState;
    this.currentState = state;
    this.logger.debug(
      `[DEBUG] StateManager.setState - State changed: ${previousState} → ${state}`,
    );
  }

  isRedisMode(): boolean {
    return this.currentState === SeederState.REDIS_MODE;
  }

  isSqliteMode(): boolean {
    return this.currentState === SeederState.SQLITE_MODE;
  }
}
