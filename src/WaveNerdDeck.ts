import { BeatManager, BeatManagerUpdateEvent } from './BeatManager';
import { GL, GLCat, GLCatBuffer, GLCatFramebuffer, GLCatProgram, GLCatTexture } from '@fms-cat/glcat-ts';
import { shaderchunkPost, shaderchunkPre, shaderchunkPreLines } from './shaderchunks';
import { EventEmittable } from './utils/EventEmittable';
import { applyMixins } from './utils/applyMixins';

interface WavenerdDeckProgram {
  program: GLCatProgram;
  code: string;
  requiredSamples: Set<string>;
}

interface WavenerdDeckSampleEntry {
  name: string;
  texture: GLCatTexture;
  sampleRate: number;
  duration: number;
}

const vertQuad = `attribute vec2 p;
void main() {
  gl_Position = vec4( p, 0.0, 1.0 );
}
`;

export class WavenerdDeck {
  /**
   * Threshold of time error, in seconds.
   */
  public timeErrorThreshold: number;

  /**
   * Its host deck.
   * It's highly recommended to connect the node of the host deck into the node of this deck, to ensure the timing consistency.
   */
  public hostDeck?: WavenerdDeck;

  /**
   * Its current cue status.
   * `'none'`: There is nothing in its current cue.
   * `'ready'`: There is a cue shader and is ready to be applied.
   * `'applying'`: There is a cue shader and is going to be applied in the next bar.
   */
  private __cueStatus: 'none' | 'ready' | 'applying' = 'none';
  public get cueStatus(): 'none' | 'ready' | 'applying' {
    return this.__cueStatus;
  }

  /**
   * Its buffer size.
   */
  private __bufferSize: number;
  public get bufferSize(): number {
    return this.__bufferSize;
  }

  /**
   * Its chunk size.
   */
  private __chunkSize: number;
  public get chunkSize(): number {
    return this.__chunkSize;
  }

  private __chunkHead = 0;

  /**
   * Its current bpm.
   */
  public get bpm(): number {
    return this.beatManager.bpm;
  }
  public set bpm( value: number ) {
    this.beatManager.bpm = value;
  }

  /**
   * Its current time.
   */
  private __time = 0;
  public get time(): number {
    if ( this.hostDeck ) {
      return this.hostDeck.time;
    }

    return this.__time;
  }

  /**
   * Its bound `GLCat`.
   */
  private __glCat: GLCat;
  public get glCat(): GLCat {
    return this.__glCat;
  }

  /**
   * Its last compile error happened in [[WavenerdDeck.compile]].
   */
  private __lastError: any;
  public get lastError(): any {
    return this.__lastError;
  }

  /**
   * Its binded `AudioContext`.
   */
  private __audio: AudioContext;
  public get audio(): AudioContext {
    return this.__audio;
  }

  /**
   * Its node of the AudioContext.
   */
  private __node: ScriptProcessorNode;
  public get node(): ScriptProcessorNode {
    return this.__node;
  }

  /**
   * Alias for the `audio.sampleRate` .
   */
  public get sampleRate(): number {
    return this.__audio.sampleRate;
  }

  private __beatManager: BeatManager;
  public get beatManager(): BeatManager {
    const hostDeckBeatManager = this.hostDeck?.beatManager;
    if ( hostDeckBeatManager ) {
      return hostDeckBeatManager;
    }

    return this.__beatManager;
  }

  private __bufferQuad: GLCatBuffer;
  private __framebufferTexture: GLCatTexture;
  private __framebuffer: GLCatFramebuffer;
  private __program: WavenerdDeckProgram | null = null;
  private __programCue: WavenerdDeckProgram | null = null;
  private __pixelBuffer: Float32Array;

  private __samples = new Map<string, WavenerdDeckSampleEntry>();
  private get samples(): Map<string, WavenerdDeckSampleEntry> {
    if ( this.hostDeck ) {
      return this.hostDeck.samples;
    }

    return this.__samples;
  }

  /**
   * Constructor of the WavenerdDeck.
   */
  public constructor( {
    glCat,
    audio,
    hostDeck,
    bufferSize,
    chunkSize,
    bpm,
    timeErrorThreshold
  }: {
    glCat: GLCat;
    audio: AudioContext;
    hostDeck?: WavenerdDeck;
    bufferSize?: number;
    chunkSize?: number;
    bpm?: number;
    timeErrorThreshold?: number;
  } ) {
    this.timeErrorThreshold = timeErrorThreshold ?? 0.01;
    this.__bufferSize = bufferSize ?? 2048;
    this.__chunkSize = chunkSize ?? 64;

    // -- host deck --------------------------------------------------------------------------------
    if ( hostDeck ) {
      this.hostDeck = hostDeck;
    }

    // -- beat manager -----------------------------------------------------------------------------
    this.__beatManager = new BeatManager();
    this.__beatManager.bpm = bpm ?? 140;
    this.__beatManager.on( 'changeBPM', ( { bpm } ) => {
      this.__chunkHead = 0;
      this.__emit( 'changeBPM', { bpm } );
    } );

    // -- glCat ------------------------------------------------------------------------------------
    this.__glCat = glCat;
    this.__bufferQuad = this.__glCat.createBuffer()!;
    this.__bufferQuad.setVertexbuffer( new Float32Array( [ -1, -1, 1, -1, -1, 1, 1, 1 ] ) );
    this.__framebufferTexture = this.__glCat.createTexture()!;
    this.__framebufferTexture.setTextureFromFloatArray(
      this.__bufferSize / 2,
      this.__chunkSize,
      null,
      GL.RGBA
    );
    this.__framebuffer = this.__glCat.createFramebuffer()!;
    this.__framebuffer.attachTexture( this.__framebufferTexture );
    this.__pixelBuffer = new Float32Array( this.__bufferSize * 2 * this.__chunkSize );

    // -- audio ------------------------------------------------------------------------------------
    this.__audio = audio;
    this.__node = audio.createScriptProcessor( this.__bufferSize, 2, 2 );
    this.__node.onaudioprocess = ( event ) => this.__handleProcess( event );
  }

  /**
   * Dispose this WavenerdDeck.
   */
  public dispose(): void {
    this.__setCueStatus( 'none' );
    this.__bufferQuad.dispose();
    if ( this.__program ) {
      this.__program.program.dispose( true );
    }
    if ( this.__programCue ) {
      this.__programCue.program.dispose( true );
    }
  }

  /**
   * Compile given shader code and cue the shader.
   */
  public async compile( code: string ): Promise<void> {
    const program = await this.__glCat.lazyProgramAsync(
      vertQuad,
      shaderchunkPre + code + shaderchunkPost
    ).catch( ( e ) => {
      const error = this.__processErrorMessage( e );
      this.__lastError = error;
      this.__programCue = null;
      this.__setCueStatus( 'none' );
      this.__emit( 'error', { error } );
      throw new Error( error ?? undefined );
    } );

    const requiredSamples = new Set<string>();
    for ( const name of this.samples.keys() ) {
      if ( code.search( 'sample_' + name ) !== -1 ) {
        requiredSamples.add( name );
      }
    }

    this.__programCue = {
      program,
      code,
      requiredSamples
    };
    this.__setCueStatus( 'ready' );
    this.__emit( 'error', { error: null } );
    this.__lastError = null;
  }

  /**
   * Apply the cue shader after the bar ends.
   */
  public applyCue(): void {
    if ( this.__cueStatus === 'ready' ) {
      this.__setCueStatus( 'applying' );
    }
  }

  /**
   * Load a sample and store as a uniform texture.
   */
  public async loadSample( name: string, buffer: ArrayBuffer ): Promise<void> {
    this.__audio.decodeAudioData( buffer )
    .then( ( audioBuffer ) => {
      const { sampleRate, duration } = audioBuffer;
      const frames = audioBuffer.length;
      const width = 2048;
      const lengthCeiled = Math.ceil( frames / 2048.0 );
      const height = lengthCeiled;

      const buffer = new Float32Array( width * height * 4 );
      const channels = audioBuffer.numberOfChannels;

      const dataL = audioBuffer.getChannelData( 0 );
      const dataR = audioBuffer.getChannelData( channels === 1 ? 0 : 1 );

      for ( let i = 0; i < frames; i ++ ) {
        buffer[ i * 4 + 0 ] = dataL[ i ];
        buffer[ i * 4 + 1 ] = dataR[ i ];
      }

      const texture = this.__glCat.createTexture()!;
      texture.setTextureFromFloatArray( width, height, buffer, GL.RGBA );
      texture.textureFilter( GL.NEAREST );

      this.__samples.set(
        name,
        {
          name,
          texture,
          sampleRate,
          duration
        }
      );

      if ( this.__program && this.__program.code.search( 'sample_' + name ) ) {
        this.__program.requiredSamples.add( name );
      }

      if ( this.__programCue && this.__programCue.code.search( 'sample_' + name ) ) {
        this.__programCue.requiredSamples.add( name );
      }

      this.__emit( 'loadSample', { name, duration, sampleRate } );
    } );
  }

  /**
   * Delete a sample.
   */
  public deleteSample( name: string ): void {
    if ( this.__samples.has( name ) ) {
      this.__samples.delete( name );
      this.__emit( 'deleteSample', { name } );
    }
  }

  private __handleProcess( event: AudioProcessingEvent ): void {
    let time = this.time;
    if ( !this.hostDeck ) {
      time += this.__bufferSize / this.__audio.sampleRate;
      if ( this.timeErrorThreshold < Math.abs( time - event.playbackTime ) ) {
        time = event.playbackTime;
      }
    }
    this.__time = time;

    const beatManagerUpdateEvent = this.beatManager.update( time );

    const { bar } = beatManagerUpdateEvent;

    const outL = event.outputBuffer.getChannelData( 0 );
    const outR = event.outputBuffer.getChannelData( 1 );

    // should I process the next program?
    const { sampleRate, __bufferSize: bufferSize } = this;
    const beginNext = this.__cueStatus === 'applying'
      ? Math.min( bufferSize, Math.floor( ( 1.0 - bar ) * sampleRate ) )
      : bufferSize;

    if ( this.__chunkHead === 0 ) {
      this.__prepareBuffer( beatManagerUpdateEvent );
    }

    // insert into its audio buffer
    for ( let i = 0; i < beginNext; i ++ ) {
      const chunkIndex = this.__chunkHead * this.__bufferSize * 2;

      outL[ i ] = this.__pixelBuffer[ chunkIndex + i * 2 + 0 ];
      outR[ i ] = this.__pixelBuffer[ chunkIndex + i * 2 + 1 ];
    }

    // process the next program??
    if ( beginNext !== bufferSize ) {
      this.__setCueStatus( 'none' );

      if ( this.__programCue ) {
        const prevProgram = this.__program;
        this.__program = this.__programCue;

        if ( prevProgram ) {
          prevProgram.program.dispose( true );
        }
        this.__programCue = null;

        // render
        this.__prepareBuffer( beatManagerUpdateEvent );
      }

      this.__chunkHead = 0;

      // insert into its audio buffer
      for ( let i = beginNext; i < bufferSize; i ++ ) {
        outL[ i ] = this.__pixelBuffer[ i * 2 + 0 ];
        outR[ i ] = this.__pixelBuffer[ i * 2 + 1 ];
      }
    }

    this.__chunkHead = ( this.__chunkHead + 1 ) % this.__chunkSize;

    // emit an event
    this.__emit( 'process' );
  }

  private __prepareBuffer( event: BeatManagerUpdateEvent ): void {
    const {
      time,
      beat,
      bar,
      sixteenBar,
      bpm
    } = event;
    const beatSeconds = BeatManager.CalcBeatSeconds( bpm );
    const barSeconds = BeatManager.CalcBarSeconds( bpm );
    const sixteenBarSeconds = BeatManager.CalcSixteenBarSeconds( bpm );
    const { sampleRate, __bufferSize: bufferSize, __chunkSize: chunkSize } = this;
    const { gl } = this.__glCat;

    // render
    if ( this.__program ) {
      this.__glCat.useProgram( this.__program.program );
      gl.viewport( 0, 0, this.__bufferSize / 2, this.__chunkSize );
      gl.bindFramebuffer( gl.FRAMEBUFFER, this.__framebuffer.raw );
      gl.blendFunc( GL.ONE, GL.ZERO );

      this.samples.forEach( ( sample ) => {
        this.__program!.program.uniformTexture( 'sample_' + sample.name, sample.texture );
        this.__program!.program.uniform4f(
          'sample_' + sample.name + '_meta',
          sample.texture.width,
          sample.texture.height,
          sample.sampleRate,
          sample.duration
        );
      } );

      this.__program.program.attribute( 'p', this.__bufferQuad, 2 );
      this.__program.program.uniform1f( 'bpm', this.bpm );
      this.__program.program.uniform1f( '_deltaSample', 1.0 / sampleRate );
      this.__program.program.uniform1f( '_deltaChunk', this.__bufferSize / sampleRate );
      this.__program.program.uniform4f(
        'timeLength',
        beatSeconds,
        barSeconds,
        sixteenBarSeconds,
        1E16
      );
      this.__program.program.uniform4f(
        '_timeHead',
        beat * beatSeconds,
        bar * barSeconds,
        sixteenBar * sixteenBarSeconds,
        time
      );

      gl.drawArrays( gl.TRIANGLE_STRIP, 0, 4 );

      // read pixels
      gl.flush();
      gl.readPixels(
        0, // x
        0, // y
        bufferSize / 2, // width
        chunkSize, // height
        GL.RGBA, // format
        GL.FLOAT, // type
        this.__pixelBuffer // dst
      );
    }
  }

  private __setCueStatus( cueStatus: 'none' | 'ready' | 'applying' ): void {
    this.__cueStatus = cueStatus;
    this.__emit( 'changeCueStatus', { cueStatus } );
  }

  private __processErrorMessage( error: any ): string | null {
    const str: string | undefined = error?.message;
    if ( !str ) { return null; }

    return str.replace( /ERROR: (\d+):(\d+)/g, ( match, ...args ) => {
      const line = parseInt( args[ 1 ] ) - shaderchunkPreLines + 1;
      return `ERROR: ${ args[ 0 ] }:${ line }`;
    } );
  }
}

export interface WavenerdDeck extends EventEmittable<{
  process: void;
  changeCueStatus: { cueStatus: 'none' | 'ready' | 'applying' };
  loadSample: { name: string; sampleRate: number; duration: number }
  deleteSample: { name: string };
  changeBPM: { bpm: number };
  error: { error: string | null };
}> {}
applyMixins( WavenerdDeck, [ EventEmittable ] );
